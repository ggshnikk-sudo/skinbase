import { getUser, json, requireAuth } from '../../_lib/auth.js';
import { catboxAddToAlbum, catboxFileName } from '../../_lib/catbox.js';
import { deleteStored, uploadCape } from '../../_lib/storage.js';
import { MAX_PNG_BYTES, tooLargeMessage } from '../../_lib/limits.js';
import { checkCapePng } from '../../_lib/cape-check.js';

// Загрузка капы: multipart/form-data с полями file (PNG), name, tags (опц.)
// Файл сохраняется в активном хранилище (S3-совместимый бакет, а при его
// отсутствии — CatBox) и, если это CatBox, добавляется в альбом Capes.
// Ограничений по размерности нет: внешние хостинги берут и стеки в разы выше
// 4096 px, проверено на плащах, что уже лежат в базе.
export async function onRequest(context) {
  // Ловим всё, что вылетело из основного тела, и отдаём JSON, а не аварийную
  // страницу платформы: её фронтенд разобрать не может.
  // Статус именно 500 — тело ответа 502 Cloudflare подменяет своим текстом
  // «error code: 502», и клиент вместо разбираемого JSON получает мусор.
  try {
    return await handle(context);
  } catch (e) {
    console.error('v3 upload: необработанная ошибка:', (e && e.stack) || e);
    return json({ error: 'Внутренняя ошибка загрузки' }, 500);
  }
}

async function handle(context) {
  const { request, env, waitUntil } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  const file = form.get('file');
  const name = (form.get('name') || '').trim();
  const tags = (form.get('tags') || '').trim();

  if (!file || !name) {
    return json({ error: 'file and name required' }, 400);
  }
  if (!(file instanceof File)) {
    return json({ error: 'file must be a file' }, 400);
  }
  if (file.size > MAX_PNG_BYTES) {
    return json({ error: tooLargeMessage() }, 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Проверка формата — тем же кодом, которым потом режется превью. Отклонённое
  // сразу, а не «положили в базу, а карточка потом пустая».
  const check = checkCapePng(bytes, { allowStack: false });
  if (!check.ok) {
    return json({ error: check.error }, 400);
  }

  // 1. Сохранить файл (CatBox, а при его отказе — резервный бакет)
  let value, storage;
  try {
    ({ value, storage } = await uploadCape(env, bytes));
  } catch (e) {
    // Причина в лог — по ней видно, ответило хранилище ошибкой, не отдало ли
    // файл или не дождались. Клиенту — короткий JSON, который фронтенд умеет
    // показать, без технического хвоста.
    console.error('v3 upload: хранилище не приняло файл:', (e && e.message) || e);
    return json({ error: 'Файл не загрузился на хранилище, попробуй ещё раз' }, 503);
  }

  // 2. Записать метаданные в D1 (value = публичная ссылка на файл)
  let skinId;
  try {
    const info = await env.DB.prepare(
      "INSERT INTO skins (user_id, name, category, value, tags) VALUES (?, ?, 'cape', ?, ?)"
    ).bind(user.id, name, value, tags).run();
    skinId = info.meta.last_row_id;
  } catch (e) {
    // Откат: не оставляем осиротевший файл в хранилище навсегда.
    await deleteStored(env, value);
    // Раньше здесь стоял `throw e`, и наружу уходил 500 в виде текста
    // `error code: 1101` от Cloudflare — не JSON. Фронтенд на таком ответе
    // падал в разборе JSON и показывал пользователю только «Unexpected token»,
    // хотя файл на CatBox уже был удалён. Теперь причина уходит в лог, а
    // клиенту — нормальный JSON.
    console.error('v3 upload: не удалось записать метаданные, файл откатан:', e);
    return json({
      error: 'Файл загружен, но не записан в галерею',
      detail: String((e && e.message) || e),
    }, 500);
  }

  // 3. В альбом — на фоне, чтобы не задерживать ответ. Альбом есть только
  // у CatBox, у бакета понятия альбома не существует. Важно смотреть на то,
  // куда лег файл по факту, а не на то, что настроено: сработал резерв — значит
  // в альбоме этому плащу места нет.
  if (storage === 'catbox') {
    waitUntil(catboxAddToAlbum(env, [catboxFileName(value)])
      .catch((e) => console.warn('Album add failed:', e)));
  }

  return json({
    skin: {
      id: skinId,
      name,
      category: 'cape',
      value,
      storage,
      tags,
      url: `/api/v3/skin-file/${skinId}.png`
    }
  }, 201);
}
import { getUser, json, requireAuth } from '../../../_lib/auth.js';
import { catboxAddToAlbum, catboxFileName } from '../../../_lib/catbox.js';
import { deleteStored, uploadCape } from '../../../_lib/storage.js';
import { MAX_PNG_BYTES, tooLargeMessage } from '../../../_lib/limits.js';
import { checkCapePng } from '../../../_lib/cape-check.js';

// Загрузка анимированного капа (Stacked PNG — кадры друг под другом):
// multipart/form-data с полями file (PNG), name, tags. Метаданные кадров
// (количество, размер) клиенту не нужны — стек режет сам мод капов.
//
// Высота стека в разы превышает 4096 px (до 29696 у уже залитых), и внешнее
// хранилище такие файлы берёт — отдельного пути хранения не нужно.
export async function onRequest(context) {
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
  // Формат читается тем же кодом, что и превью: сервер и браузер обязаны
  // считать плащом одно и то же, иначе зальётся файл, который не рисуется.
  const check = checkCapePng(bytes);
  if (!check.ok) {
    return json({ error: check.error }, 400);
  }

  // 1. Сохранить файл (CatBox, а при его отказе — резервный бакет)
  let value, storage;
  try {
    ({ value, storage } = await uploadCape(env, bytes));
  } catch (e) {
    console.error('animated upload: хранилище не приняло файл:', (e && e.message) || e);
    // 503, а не 502: тело 502 Cloudflare подменяет своим «error code: 502»,
    // и фронтенд вместо JSON получает неразбираемый текст.
    return json({ error: 'Файл не загрузился на хранилище, попробуй ещё раз' }, 503);
  }

  // 2. Метаданные в D1 (отдельная таблица animated — не мешаем с обычными капами)
  let skinId;
  try {
    const info = await env.DB.prepare(
      'INSERT INTO animated (user_id, name, value, tags) VALUES (?, ?, ?, ?)'
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
    console.error('animated upload: не удалось записать метаданные, файл откатан:', e);
    return json({
      error: 'Файл загружен, но не записан в галерею',
      detail: String((e && e.message) || e),
    }, 500);
  }

    // 3. В альбом — на фоне. Альбом есть только у CatBox, и только если файл
  // лёг именно туда: сработал резерв — в альбоме этому плащу места нет.
  if (storage === 'catbox') {
    waitUntil(catboxAddToAlbum(env, [catboxFileName(value)])
      .catch((e) => console.warn('Album add failed:', e)));
  }

  return json({
    skin: {
      id: skinId,
      name,
      animated: true,
      value,
      storage,
      tags,
      url: `/api/animated/v1/skin-file/${skinId}.png`
    }
  }, 201);
}
// Работа с CatBox (files.catbox.moe) как внешним хранилищем капов.
// Требует env:
//   CATBOX_USERHASH — userhash аккаунта CatBox (секрет; нужен для альбомов и удаления)
//   CATBOX_ALBUM    — короткий хеш альбома Capes (например "d3da76244a8ded502e045c72f")
//
// Формат CatBox API (https://catbox.moe/user/api.php):
//   fileupload → https://files.catbox.moe/<name>
//   addtoalbum: userhash + short + files (имена уже загруженных файлов, через пробел)
//   deletefiles: userhash + files (имена через пробел)
import { isPng } from '../../public/cape-format.js';

export const CATBOX_API = 'https://catbox.moe/user/api.php';
export const CATBOX_FILE_HOST = 'files.catbox.moe';

// CatBox/Cloudflare режет бот-запросы (520/502 без UA) — браузерный fingerprint решает.
const PG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Потолок ожидания CatBox. Загрузка капы весит до 20 МБ и обычно уходит за
// секунды; если upstream провис, ждать бессмысленно: Functions всё равно убьёт
// вызов по своему лимиту, а пользователь вместо внятного ответа получит
// HTML-страницу 5xx от платформы — ровно тот ответ, который фронтенд не умеет
// разбирать. Своим таймаутом мы превращаем это в быстрый ответ с JSON.
// Перекрыть из env: CATBOX_TIMEOUT_MS.
const CATBOX_TIMEOUT_MS = 20_000;

export function isCatboxFile(url) {
  try {
    return new URL(url).hostname === CATBOX_FILE_HOST;
  } catch {
    return false;
  }
}

// Имя файла (последний сегмент пути) из URL catbox, или null.
export function catboxFileName(url) {
  try {
    const u = new URL(url);
    if (u.hostname === CATBOX_FILE_HOST) {
      const name = u.pathname.split('/').filter(Boolean).pop();
      if (name) return name;
    }
  } catch {}
  return null;
}

// Загрузка капы идёт дольше прочих вызовов: тело до 20 МБ уходит в CatBox, и
// ответ приходит уже после того, как файл доехал. Общий потолок из 20 секунд
// на такую загрузку не рассчитан, поэтому у неё свой, более щедрый бюджет.
// Перекрыть из env: CATBOX_UPLOAD_TIMEOUT_MS.
const CATBOX_UPLOAD_TIMEOUT_MS = 60_000;

// Сколько раз пробуем загрузить заново, прежде чем сдаться. CatBox периодически
// отвечает «готово» и не отдаёт файл (см. verifyCapeAtCatbox) — с новым именем
// попытка обычно проходит.
const CATBOX_UPLOAD_ATTEMPTS = 3;

/** Потолок ожидания для конкретного окружения; мусорное значение игнорируем. */
function timeoutFor(env) {
  const raw = Number(env.CATBOX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CATBOX_TIMEOUT_MS;
}

/** Потолок ожидания загрузки; по умолчанию щедрее обычного. */
function uploadTimeoutFor(env) {
  const raw = Number(env.CATBOX_UPLOAD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CATBOX_UPLOAD_TIMEOUT_MS;
}

async function api(form, { timeoutMs = CATBOX_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(CATBOX_API, {
      method: 'POST',
      body: form,
      headers: {
        'User-Agent': PG_UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://catbox.moe'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    // fetch обрывается сам по себе и по сети, и по таймауту. Разводим их явно:
    // «не дождались» и «не соединились» — разные неисправности.
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`catbox не ответил за ${timeoutMs} мс`);
    }
    throw e;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`catbox api error ${res.status}: ${text}`);
  return text.trim();
}

/**
 * Проверить, что загруженный файл действительно доступен и это PNG.
 *
 * CatBox отвечает на fileupload корректным URL и при этом может не сохранить
 * файл: ссылка ведёт на 404 или на пустое тело. Со стороны Worker это
 * неотличимо от успеха, если просто довериться ответу API, — а пользователь
 * потом получает плащ в галерее, который не грузится никогда. Поэтому
 * загрузка проверяется чтением по выданной ссылке до записи в D1.
 */
export async function verifyCapeAtCatbox(url, { timeoutMs = 15_000 } = {}) {
  let res;
  try {
    // С меткой: только что загруженный файл мог остаться в кэше edge с
    // предыдущего 404 на это же имя.
    res = await fetch(withCacheBust(url), {
      headers: { 'User-Agent': PG_UA, 'Accept': 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    return { ok: false, reason: `не достучались: ${String((e && e.message) || e)}` };
  }
  if (!res.ok) return { ok: false, reason: `catbox отдал HTTP ${res.status}` };
  let body;
  try {
    body = await res.arrayBuffer();
  } catch (e) {
    return { ok: false, reason: `тело не прочиталось: ${String((e && e.message) || e)}` };
  }
  if (!isUsableCapeBytes(body)) {
    return { ok: false, reason: `catbox отдал ${body.byteLength} байт вместо PNG` };
  }
  return { ok: true, bytes: body.byteLength };
}

// Загрузка бинарных данных → прямой URL https://files.catbox.moe/<name>
//
// Ответ API не считается успехом, пока файл не прочитан по выданной ссылке.
// Иначе CatBox-«успех» без файла превращается в битый плащ в галерее.
//
// maxAttempts — сколько раз пробуем. По умолчанию CATBOX_UPLOAD_ATTEMPTS.
// Вызывающий, у которого есть резервное хранилище, ставит 1: ждать три попытки
// в провалившийся CatBox значит задержать пользователя на минуту ради
// хранилища, которое всё равно сработает.
export async function catboxUpload(env, bytes, filename, { maxAttempts = CATBOX_UPLOAD_ATTEMPTS } = {}) {
  let last = 'причина неизвестна';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Своё имя на каждую попытку: повтор с тем же именем CatBox склонен
    // вернуть ту же битую ссылку из своего кэша.
    const name = filename || `${crypto.randomUUID()}.png`;
    const form = new FormData();
    form.set('reqtype', 'fileupload');
    if (env.CATBOX_USERHASH) form.set('userhash', env.CATBOX_USERHASH);
    form.set('fileToUpload', new File([bytes], name, { type: 'image/png' }));

    let url;
    try {
      url = await api(form, { timeoutMs: uploadTimeoutFor(env) });
    } catch (e) {
      last = String((e && e.message) || e);
      continue;
    }
    if (!/^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/.test(url)) {
      last = 'catbox вернул не URL: ' + url;
      continue;
    }

    const check = await verifyCapeAtCatbox(url);
    if (check.ok) return url;

    last = check.reason;
    console.warn(`catbox: попытка ${attempt}/${maxAttempts}, ${url} — ${check.reason}`);
    // Битый файл не оставляем в аккаунте мусором.
    await catboxDelete(env, [name]).catch(() => {});
  }
  throw new Error(
    `catbox не отдал файл после ${maxAttempts} попыток: ${last}`
  );
}

// Добавить уже загруженные файлы (по именам) в альбом.
export async function catboxAddToAlbum(env, filenames) {
  if (!env.CATBOX_USERHASH || !env.CATBOX_ALBUM) {
    throw new Error('CATBOX_USERHASH / CATBOX_ALBUM not configured');
  }
  const names = filenames.filter(Boolean);
  if (names.length === 0) return;
  const form = new FormData();
  form.set('reqtype', 'addtoalbum');
  form.set('userhash', env.CATBOX_USERHASH);
  form.set('short', env.CATBOX_ALBUM);
  form.set('files', names.join(' '));
  await api(form, { timeoutMs: timeoutFor(env) });
}

// Удалить файлы с catbox по именам (тихо, если userhash не задан).
export async function catboxDelete(env, filenames) {
  if (!env.CATBOX_USERHASH) return;
  const names = filenames.filter(Boolean);
  if (names.length === 0) return;
  const form = new FormData();
  form.set('reqtype', 'deletefiles');
  form.set('userhash', env.CATBOX_USERHASH);
  form.set('files', names.join(' '));
  await api(form, { timeoutMs: timeoutFor(env) });
}

// ─── Раздача файла капа: значение из D1 (kv: или http) → Response с PNG ───
// Файл физически живёт на CatBox / legacy-хостинге; здесь проксируем его,
// чтобы клиенты получали PNG с нашего домена (same-origin, без CORS).
// После первого запроса ответ кэшируется на CDN (cf.cacheEverything).
// Политика кэша по типу ссылки. Это НЕ украшение: от неё зависит, увидит ли
// игрок сменённый плащ.
//
// Ссылка по ИМЕНИ игрока (/skins/<username>/cape.png) меняет содержимое
// без смены адреса. Если отдать её как public, edge Cloudflare кладёт её в
// кэш, и после смены капа все до часа (или дольше — см. Cache Rule зоны)
// получают старый плащ. Сбросить edge-кэш из Worker нельзя:
// caches.default.delete() его не касается. Поэтому такая ссылка no-store.
export const CACHE_MUTABLE = 'no-store, no-cache, must-revalidate';

// Ссылка по id файла (/skin-file/<id>.png) неизменяема: PUT умеет править
// только name/tags, а замена картинки создаёт новый id. Её кэшировать можно.
export const CACHE_IMMUTABLE = 'public, max-age=3600';

// Ссылка с id, для которого файл не нашёлся. Кэшировать нельзя ни в коем
// случае: отсутствие файла чаще всего временное (CatBox моргнул, файл ещё
// доехал), а закешированный 404 живёт на edge часами и не даёт ничего
// переделать без сброса кэша зоны.
export const CACHE_MISSING = 'no-store, no-cache, must-revalidate';

// CatBox изредка отдаёт 200 с пустым телом: файл он ещё не дописал либо
// upstream отвалился. Такой ответ нельзя пропускать дальше — иначе плащ
// выглядит как рабочий (200, image/png), а на деле пустой, и эта пустота
// уезжает в кэш edge вместе с заголовком про изображение.
function isUsableCapeBytes(bytes) {
  return bytes && bytes.byteLength >= 8 && isPng(new Uint8Array(bytes, 0, 8));
}

/** CatBox-ссылка с добавленным меткой: обходит кэш подзапроса. */
function withCacheBust(value) {
  return value + (value.includes('?') ? '&' : '?') + '_cb=' + Date.now().toString(36);
}

/** Тело файла с CatBox либо null, если это не изображение. */
async function fetchCapeBytes(value, { bust = false } = {}) {
  try {
    const upstream = await fetch(bust ? withCacheBust(value) : value, {
      headers: {
        'User-Agent': PG_UA,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    if (!upstream.ok) {
      console.warn(`catbox ${value}: HTTP ${upstream.status}`);
      return null;
    }
    // Тело читается целиком: отдать клиенту можно только проверенные байты.
    // Файл капы — до 20 МБ, столько же уже держится в памяти при загрузке.
    const body = await upstream.arrayBuffer();
    if (!isUsableCapeBytes(body)) {
      console.warn(`catbox ${value}: ${body.byteLength} байт вместо PNG`);
      return null;
    }
    return body;
  } catch (e) {
    console.warn(`catbox ${value}: ${String((e && e.message) || e)}`);
    return null;
  }
}

export async function proxyTextureFile(value, env, cacheControl = CACHE_IMMUTABLE) {
  if (!value) return null;

  // Legacy-капы лежат в KV под ключом "kv:<name>". Проверять это ДО guard'а на
  // http: иначе ветка unreachable, и все старые капы отдавали 404.
  if (value.startsWith('kv:')) {
    const data = await env.SKINS_KV.get(value.slice(3), { type: 'arrayBuffer' });
    if (!isUsableCapeBytes(data)) return null;
    return new Response(data, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': cacheControl
      }
    });
  }

  // Внешнее хранилище в старом формате: "gh:<path>" (например gh:capes/115.png,
  // gh:animated/3.png). Поддерживаем два режима:
  // 1) GitHub-репозиторий (в т.ч. приватный): GH_CAPES_REPO/GH_ASSETS_REPO +
  //    GH_CAPES_TOKEN/GH_TOKEN/GITHUB_TOKEN, опционально GH_CAPES_BRANCH (main),
  //    GH_CAPES_PREFIX (напр. "assets" → assets/capes/115.png).
  // 2) Публичная база URL: GH_CAPES_BASE / CAPE_FILES_BASE / S3_PUBLIC_BASE.
  if (value.startsWith('gh:')) {
    const path = value.slice(3).replace(/^\/+/, '');
    const file = path.split('/').filter(Boolean).pop() || path;

    const tryFetchGhUrl = async (url, headers) => {
      try {
        const upstream = await fetch(url, {
          headers: headers || { 'User-Agent': PG_UA, 'Accept': 'image/*,*/*;q=0.8' },
          cf: { cacheTtl: 3600, cacheEverything: true }
        });
        if (!upstream.ok) return null;
        const body = await upstream.arrayBuffer();
        return isUsableCapeBytes(body) ? body : null;
      } catch {
        return null;
      }
    };

    // 1) GitHub repo storage (supports private repos via token)
    const ghRepo = (env && (env.GH_CAPES_REPO || env.GH_ASSETS_REPO || env.GITHUB_CAPES_REPO)) || 'ggshnikk-sudo/skinbase-assets';
    if (ghRepo) {
      const branch = (env && (env.GH_CAPES_BRANCH || env.GH_ASSETS_BRANCH)) || 'main';
      const token = env && (env.GH_CAPES_TOKEN || env.GH_ASSETS_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || env.GITHUB_API_TOKEN);
      const prefixRaw = env && (env.GH_CAPES_PREFIX || env.GH_ASSETS_PREFIX);
      const prefixes = [];
      if (prefixRaw != null && String(prefixRaw).trim() !== '') prefixes.push(String(prefixRaw).replace(/^\/+|\/+$/g, '') + '/');
      // common layout: gh:capes/115.png -> assets/capes/115.png
      prefixes.push('assets/');
      prefixes.push('');
      const repoPaths = [];
      const seenPaths = new Set();
      for (const pfx of prefixes) {
        const rp = pfx + path;
        if (!seenPaths.has(rp)) { seenPaths.add(rp); repoPaths.push(rp); }
      }
      const authHeaders = {
        'User-Agent': PG_UA,
        'Accept': 'application/vnd.github.raw'
      };
      if (token) authHeaders['Authorization'] = 'Bearer ' + token;
      for (const rp of repoPaths) {
        const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${rp.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
        let body = await tryFetchGhUrl(apiUrl, authHeaders);
        if (!body && token) {
          // fallback: raw.githubusercontent.com with auth (some setups)
          const rawUrl = `https://raw.githubusercontent.com/${ghRepo}/${encodeURIComponent(branch)}/${rp.split('/').map(encodeURIComponent).join('/')}`;
          body = await tryFetchGhUrl(rawUrl, { 'User-Agent': PG_UA, 'Accept': 'image/*,*/*;q=0.8', 'Authorization': 'Bearer ' + token });
        }
        if (!body) continue;
        const headers = new Headers();
        headers.set('Content-Type', 'image/png');
        headers.set('Cache-Control', cacheControl);
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(body, { headers });
      }
    }

    // 2) Public/base URL candidates
    const bases = [];
    for (const key of ['GH_CAPES_BASE', 'CAPE_FILES_BASE', 'S3_PUBLIC_BASE']) {
      const v = env && env[key];
      if (v) bases.push(String(v).replace(/\/+$/, ''));
    }
    const tried = new Set();
    const candidates = [];
    for (const base of bases) {
      candidates.push(base + '/' + path);
      if (file && file !== path) candidates.push(base + '/' + file);
      // S3_PUBLIC_BASE часто указывает на /public/<bucket>, а путь в значении
      // уже начинается с имени "папки" (capes/..., animated/...) — пробуем без
      // дублирующего сегмента.
      if (path.startsWith('capes/') && /\/capes$/i.test(base)) {
        candidates.push(base + '/' + path.slice('capes/'.length));
      }
      if (path.startsWith('animated/') && /\/animated$/i.test(base)) {
        candidates.push(base + '/' + path.slice('animated/'.length));
      }
    }
    for (const url of candidates) {
      if (!url || tried.has(url)) continue;
      tried.add(url);
      let body = await fetchCapeBytes(url);
      if (!body) body = await fetchCapeBytes(url, { bust: true });
      if (!body) continue;
      const headers = new Headers();
      headers.set('Content-Type', 'image/png');
      headers.set('Cache-Control', cacheControl);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(body, { headers });
    }
    console.warn('gh cape unresolved:', value);
    return null;
  }

  if (!value.startsWith('http')) return null;

  let body = await fetchCapeBytes(value);
  // Первая попытка могла отдать закэшированную на edge пустоту от прошлого
  // сбоя. Повтор с обходом кэша — шанс починиться самому, без сброса кэша
  // зоны; если файл действительно сломан, повтор просто вернёт null.
  if (!body) body = await fetchCapeBytes(value, { bust: true });
  if (!body) return null;

  const headers = new Headers();
  headers.set('Content-Type', 'image/png');
  headers.set('Cache-Control', cacheControl);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(body, { headers });
}
// Клиент S3-совместимого объектного хранилища (подпись AWS Signature V4).
//
// Зачем отдельный модуль, если уже есть CatBox: CatBox — это голая form-POST
// без подписи, один конкретный сервис. S3 же — протокол, который повторяют
// Cloudflare R2, Backblaze B2, Yandex Object Storage, Cloud.ru и большинство
// остальных. Клиент к протоколу пишется один раз, а смена провайдера — это
// четыре переменные окружения, а не правка кода.
//
// Требует env:
//   S3_ENDPOINT         — корень API, напр. https://<ref>.storage.supabase.co/storage/v1/s3
//   S3_BUCKET           — имя бакета
//   S3_REGION           — регион бакета
//   S3_ACCESS_KEY_ID    — публичная часть ключа
//   S3_SECRET_ACCESS_KEY— секретная часть ключа
//   S3_PUBLIC_BASE      — публичный адрес бакета для чтения без подписи
//   S3_SESSION_TOKEN    — необязательно, для временных ключей
//
// Что кладём в D1: публичный URL из S3_PUBLIC_BASE. Он открыт на чтение, поэтому
// раздача плащей (proxyTextureFile) продолжает работать как раньше, без подписи
// и без единой правки в маршрутах.

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const AWS4_REQUEST = 'aws4_request';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const DEFAULT_TIMEOUT_MS = 20_000;
// Загрузка капы весит до 20 МБ и отвечает медленнее прочих вызовов: общий
// потолок Functions всё равно убил бы вызов раньше, чем CatBox успеет ответить.
// Перекрыть из env: S3_UPLOAD_TIMEOUT_MS.
const UPLOAD_TIMEOUT_MS = 60_000;
// Сколько раз пробуем при сетевых сбоях и 5xx. Молчаливых «успехов без файла»,
// как у CatBox, здесь не бывает: S3 либо принял объект, либо ответил ошибкой.
const UPLOAD_ATTEMPTS = 3;

function hex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

export async function sha256Hex(data) {
  return hex(await crypto.subtle.digest('SHA-256', toBytes(data)));
}

async function hmac(key, data) {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : toBytes(key);
  const signKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', signKey, toBytes(data)));
}

/** RFC 3986 — encodeURIComponent не экранирует !'()*, а S3 требует именно их. */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Путь отправляется байт-в-байт как построил URL, поэтому кодируем сегменты один раз. */
function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function canonicalQuery(target) {
  const pairs = [...target.searchParams.entries()].map(
    ([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)]
  );
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Подписать запрос по AWS SigV4.
 *
 * service и payloadHash вынесены параметрами не для красоты: официальный набор
 * тест-векторов aws-sig-v4-test-suite подписывает сервис строкой "service",
 * и без возможности её подменить проверку было бы нечем.
 *
 * host в подписи обязателен (S3 требует его в SignedHeaders), но в Worker
 * заголовок Host выставляется платформой и ручной установкой запрещён, поэтому
 * он возвращается отдельно: подписываем, но не отправляем.
 */
export async function signRequest({
  method,
  url,
  region,
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  service = SERVICE,
  headers = {},
  payloadHash = EMPTY_SHA256,
  now = new Date()
}) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const toSign = { host: target.host, 'x-amz-date': amzDate };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    toSign[name.toLowerCase()] = String(value);
  }
  if (sessionToken) toSign['x-amz-security-token'] = sessionToken;

  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n].trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    target.pathname || '/',
    target.search ? canonicalQuery(target) : '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/${AWS4_REQUEST}`;
  const stringToSign = [
    ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)
  ].join('\n');

  const kDate = await hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, AWS4_REQUEST);
  const signature = hex(await hmac(kSigning, stringToSign));

  const authorization =
    `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, signedHeaders, scope, amzDate, canonicalRequest, stringToSign, host: target.host };
}

/** Хранилище настроено целиком. Частичная настройка — тоже «не настроено»: одна
 *  сломанная связка ключей должна отключить S3, а не ронять загрузку. */
export function s3Configured(env) {
  return Boolean(
    env.S3_ENDPOINT && env.S3_BUCKET && env.S3_REGION &&
    env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_PUBLIC_BASE
  );
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}

/** URL бакета для чтения без подписи. Именно он попадает в D1. */
export function s3PublicUrl(env, key) {
  return `${trimSlash(env.S3_PUBLIC_BASE)}/${encodeKey(key)}`;
}

/** URL для подписанных запросов к API. */
function objectUrl(env, key) {
  return `${trimSlash(env.S3_ENDPOINT)}/${encodeURIComponent(env.S3_BUCKET)}/${encodeKey(key)}`;
}

export function isS3File(url, env) {
  if (!s3Configured(env) || !url || typeof url !== 'string') return false;
  return url.startsWith(trimSlash(env.S3_PUBLIC_BASE) + '/');
}

export function s3KeyFromUrl(url, env) {
  if (!isS3File(url, env)) return null;
  const base = trimSlash(env.S3_PUBLIC_BASE) + '/';
  return url.slice(base.length).split('/').map(decodeURIComponent).join('/');
}

function timeoutFor(env) {
  const raw = Number(env.S3_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function uploadTimeoutFor(env) {
  const raw = Number(env.S3_UPLOAD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : UPLOAD_TIMEOUT_MS;
}

async function signedFetch(env, { method, key, body, contentType, timeoutMs }) {
  const url = objectUrl(env, key);
  const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
  const extra = {};
  if (contentType) extra['content-type'] = contentType;
  if (body) extra['x-amz-content-sha256'] = payloadHash;

  const signed = await signRequest({
    method,
    url,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    sessionToken: env.S3_SESSION_TOKEN || null,
    headers: extra,
    payloadHash
  });

  return fetch(url, {
    method,
    headers: { ...extra, Authorization: signed.authorization },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function errorText(res) {
  return res.text().then((t) => t.slice(0, 300)).catch(() => '');
}

/** Положить объект в бакет и вернуть его публичный URL. */
export async function s3Upload(env, bytes, key, contentType = 'image/png') {
  let last = 'причина неизвестна';
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await signedFetch(env, {
        method: 'PUT',
        key,
        body: bytes,
        contentType,
        timeoutMs: uploadTimeoutFor(env)
      });
    } catch (e) {
      last = String((e && e.message) || e);
      console.warn(`s3: попытка ${attempt}/${UPLOAD_ATTEMPTS} — ${last}`);
      continue;
    }

    if (res.ok) {
      const check = await verifyCapeAtS3(env, key, bytes.byteLength);
      if (check.ok) return s3PublicUrl(env, key);
      last = check.reason;
      console.warn(`s3: ${key} загружен, но проверка не прошла — ${last}`);
      await s3Delete(env, key).catch(() => {});
      continue;
    }

    // 4xx — запрос неправильный (нет ключа, бакет не создан, ключ занят не тем
    // способом). Повтор не поможет, только зря долбим upstream.
    if (res.status < 500) {
      throw new Error(`s3 ${res.status}: ${await errorText(res)}`);
    }
    last = `HTTP ${res.status}: ${await errorText(res)}`;
    console.warn(`s3: попытка ${attempt}/${UPLOAD_ATTEMPTS} — ${last}`);
  }
  throw new Error(`s3 не принял файл после ${UPLOAD_ATTEMPTS} попыток: ${last}`);
}

/** Удалить объект. Отсутствующий ключ — не ошибка: уже удалён, и нечего чинить. */
export async function s3Delete(env, key) {
  if (!key) return;
  let res;
  try {
    res = await signedFetch(env, {
      method: 'DELETE',
      key,
      timeoutMs: timeoutFor(env)
    });
  } catch (e) {
    console.warn(`s3 delete ${key}: ${String((e && e.message) || e)}`);
    return;
  }
  if (!res.ok && res.status !== 404) {
    console.warn(`s3 delete ${key}: HTTP ${res.status}`);
  }
}

/**
 * Проверить, что объект действительно лежит в бакете и открыт на чтение.
 *
 * Идём через публичный URL, потому что именно его потом прочитает игрок: запись,
 * прочитанная только по подписанному ключу, ничего не говорит о публичности.
 * Брать тело не нужно — HEAD отдаёт Content-Length и не тратит трафик, а на
 * бесплатных тарифах каждый лишний GET считается из квоты исходящего трафика.
 */
export async function verifyCapeAtS3(env, key, expectedBytes = null) {
  const url = s3PublicUrl(env, key);
  let res;
  try {
    res = await fetch(url, {
      method: 'HEAD',
      headers: { Accept: 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutFor(env))
    });
  } catch (e) {
    return { ok: false, reason: `не достучались: ${String((e && e.message) || e)}` };
  }
  if (!res.ok) return { ok: false, reason: `s3 отдал HTTP ${res.status}` };

  const length = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(expectedBytes) && Number.isFinite(length) && length !== expectedBytes) {
    return { ok: false, reason: `s3 отдал ${length} байт вместо ${expectedBytes}` };
  }
  return { ok: true, bytes: length };
}
import { json } from '../../../_lib/auth.js';
import { CACHE_MISSING, proxyTextureFile } from '../../../_lib/catbox.js';

// Раздача файла капы по id: GET /api/v3/skin-file/<id>.png
// Файл физически живёт на CatBox / legacy-хостинге — проксируем его через
// Worker, чтобы клиенты и превью сайта получают PNG с нашего домена
// (same-origin, без CORS-проблем WebGL). Ответ кэшируется на CDN Cloudflare.
// Обратная совместимость: старые записи kv: — чтение из KV.
export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const id = Number(params.id.replace(/\.png$/i, ''));
  if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);

  const skin = await env.DB.prepare(
    "SELECT value FROM skins WHERE id = ? AND category = 'cape'"
  ).bind(id).first();

  if (!skin) return json({ error: 'Cape not found' }, 404);

  const file = await proxyTextureFile(skin.value, env);
  // Файл не нашёлся — это почти всегда временно (CatBox не отдал файл), а не
  // «плаща нет». Такой ответ не кэшируется: закешированный на edge 404 живёт
  // часами и не даёт ни увидеть файл, ни починиться без сброса кэша зоны.
  if (!file) {
    const response = json({ error: 'Cape file unavailable' }, 404);
    response.headers.set('Cache-Control', CACHE_MISSING);
    return response;
  }
  return file;
}
import { json } from '../../../../_lib/auth.js';
import { CACHE_MISSING, proxyTextureFile } from '../../../../_lib/catbox.js';

// Раздача Stacked PNG анимированного капа по id: GET /api/animated/v1/skin-file/<id>.png
// Файл физически на CatBox — проксируем через Worker (same-origin, без CORS проблем).
// Ответ кэшируется на CDN Cloudflare.
export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const id = Number(params.id.replace(/\.png$/i, ''));
  if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);

  const skin = await env.DB.prepare(
    'SELECT value FROM animated WHERE id = ?'
  ).bind(id).first();

  if (!skin) return json({ error: 'Animated cape not found' }, 404);

  const file = await proxyTextureFile(skin.value, env);
  if (!file) {
    // Временная недоступность файла не кэшируется — см. v3/skin-file/[id].js.
    const missing = json({ error: 'Animated cape file unavailable' }, 404);
    missing.headers.set('Cache-Control', CACHE_MISSING);
    return missing;
  }
  return file;
}
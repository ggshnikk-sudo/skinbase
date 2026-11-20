import { json } from '../../_lib/auth.js';
import { getCachedEquipped, putCachedEquipped } from '../../_lib/cache.js';

// Все игроки с экипированными плащами одним запросом (для CSL и игры).
// ?warm=1 — служебный режим для прогрева кэша CDN.
// url — путь на файл через API (/api/v3/skin-file/<id>.png → 302 на CatBox).
export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const force = new URL(request.url).searchParams.get('warm') === '1';

  const cached = force ? null : await getCachedEquipped(request);
  if (cached) return cached;

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, ca.id AS cape_id, ca.name AS cape_name
     FROM users u
     INNER JOIN equipped e ON e.user_id = u.id
     LEFT JOIN skins ca ON e.cape_skin_id = ca.id
     WHERE e.cape_skin_id IS NOT NULL
     ORDER BY u.username`
  ).all();

  const users = results.map(row => ({
    username: row.username,
    equipped: {
      cape: {
        id: row.cape_id,
        name: row.cape_name,
        url: `/api/v3/skin-file/${row.cape_id}.png`
      }
    }
  }));

  const response = json({ count: users.length, users });
  waitUntil(putCachedEquipped(request, response));
  return response;
}
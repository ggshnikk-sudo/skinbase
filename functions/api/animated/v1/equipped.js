import { json } from '../../../_lib/auth.js';
import { getCachedEquipped, putCachedEquipped } from '../../../_lib/cache.js';

// Все игроки с экипированным анимированным капом одним запросом (для модов,
// которым нужен список анимированных капов отдельно от обычных).
// ?warm=1 — служебный режим для прогрева кэша CDN.
export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const force = new URL(request.url).searchParams.get('warm') === '1';

  const cached = force ? null : await getCachedEquipped(request);
  if (cached) return cached;

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, a.id AS cape_id, a.name AS cape_name
     FROM users u
     INNER JOIN animated_equipped ae ON ae.user_id = u.id
     LEFT JOIN animated a ON ae.animated_skin_id = a.id
     WHERE ae.animated_skin_id IS NOT NULL
     ORDER BY u.username`
  ).all();

  const users = results.map(row => ({
    username: row.username,
    equipped: {
      animated: {
        id: row.cape_id,
        name: row.cape_name,
        animated: true,
        url: `/api/animated/v1/skin-file/${row.cape_id}.png`
      }
    }
  }));

  const response = json({ count: users.length, users });
  waitUntil(putCachedEquipped(request, response));
  return response;
}
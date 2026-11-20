import { getUser, json, requireAuth } from '../../_lib/auth.js';
import { invalidateEquippedCache } from '../../_lib/cache.js';

export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method === 'GET') {
    const equipped = await env.DB.prepare(
      `SELECT ca.id AS cape_id, ca.name AS cape_name, ca.value AS cape_value
       FROM equipped e
       LEFT JOIN skins ca ON e.cape_skin_id = ca.id
       WHERE e.user_id = ?`
    ).bind(user.id).first();

    return json({
      equipped: {
        cape: equipped?.cape_id ? {
          id: equipped.cape_id,
          name: equipped.cape_name,
          url: `/api/v3/skin-file/${equipped.cape_id}.png`,
          file: equipped.cape_value && equipped.cape_value.startsWith('http') ? equipped.cape_value : null
        } : null
      }
    });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const { skin_id } = body;

    if (!skin_id) {
      return json({ error: 'skin_id required' }, 400);
    }

    // Общая библиотека: надевать можно любой кап любого пользователя
    const skin = await env.DB.prepare(
      "SELECT * FROM skins WHERE id = ? AND category = 'cape'"
    ).bind(skin_id).first();

    if (!skin) {
      return json({ error: 'Cape not found' }, 404);
    }

    await env.DB.prepare(
      `INSERT INTO equipped (user_id, cape_skin_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET cape_skin_id = ?`
    ).bind(user.id, skin_id, skin_id).run();

    await invalidateEquippedCache(request, user.username);
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE equipped SET cape_skin_id = NULL WHERE user_id = ?'
    ).bind(user.id).run();

    await invalidateEquippedCache(request, user.username);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

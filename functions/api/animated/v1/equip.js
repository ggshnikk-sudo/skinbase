import { getUser, json, requireAuth } from '../../../_lib/auth.js';
import { invalidateAnimatedCache } from '../../../_lib/cache.js';

// Второй слот экипировки — анимированный плащ. У игрока могут быть надеты
// ОДНОВРЕМЕННО обычный кап (куда: /api/v3/equip) и анимированный (сюда).
// Какой из двух показывать — решает конфиг мода, API их не смешивает.
export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method === 'GET') {
    const equipped = await env.DB.prepare(
      `SELECT a.id AS cape_id, a.name AS cape_name, a.value AS cape_value
       FROM animated_equipped ae
       LEFT JOIN animated a ON ae.animated_skin_id = a.id
       WHERE ae.user_id = ?`
    ).bind(user.id).first();

    return json({
      equipped: {
        animated: equipped?.cape_id ? {
          id: equipped.cape_id,
          name: equipped.cape_name,
          animated: true,
          url: `/api/animated/v1/skin-file/${equipped.cape_id}.png`,
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

    // Общая библиотека: надевать можно любой анимированный кап любого пользователя
    const skin = await env.DB.prepare(
      'SELECT id FROM animated WHERE id = ?'
    ).bind(skin_id).first();

    if (!skin) {
      return json({ error: 'Animated cape not found' }, 404);
    }

    await env.DB.prepare(
      `INSERT INTO animated_equipped (user_id, animated_skin_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET animated_skin_id = ?`
    ).bind(user.id, skin_id, skin_id).run();

    await invalidateAnimatedCache(request, user.username);
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE animated_equipped SET animated_skin_id = NULL WHERE user_id = ?'
    ).bind(user.id).run();

    await invalidateAnimatedCache(request, user.username);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
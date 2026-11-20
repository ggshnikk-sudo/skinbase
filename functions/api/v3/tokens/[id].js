import { getUser, json, requireAuth } from '../../../_lib/auth.js';

// DELETE /api/v3/tokens/[id] — отозвать токен
export async function onRequest(context) {
  const { request, env, params } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method !== 'DELETE') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const id = Number(params.id);
  if (!Number.isInteger(id)) {
    return json({ error: 'Invalid token id' }, 400);
  }

  const info = await env.DB.prepare(
    'DELETE FROM api_tokens WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).run();

  if (info.meta.changes === 0) {
    return json({ error: 'Token not found' }, 404);
  }

  return json({ ok: true });
}

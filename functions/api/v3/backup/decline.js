import { getUser, json, requireAuth } from '../../../_lib/auth.js';

// Отказ от бэкапа: удаляет сохранённый JSON без выдачи.
export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  await env.DB.prepare(
    'DELETE FROM skin_backups WHERE user_id = ?'
  ).bind(user.id).run();

  return json({ ok: true });
}

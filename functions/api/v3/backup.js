import { getUser, json, requireAuth } from '../../_lib/auth.js';

// Статус бэкапа удалённых скинов (после миграции на v3).
// GET /api/v3/backup → { exists, count, download_url }
export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const backup = await env.DB.prepare(
    'SELECT backup_json FROM skin_backups WHERE user_id = ?'
  ).bind(user.id).first();

  if (!backup) {
    return json({ exists: false, count: 0 });
  }

  let count = 0;
  try {
    count = JSON.parse(backup.backup_json).length;
  } catch {}

  return json({
    exists: true,
    count,
    download_url: '/api/v3/backup/download'
  });
}

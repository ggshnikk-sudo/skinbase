import { getUser, json, requireAuth } from '../../../_lib/auth.js';

// Скачать бэкап удалённых скинов как JSON-файл. После выдачи бэкап удаляется.
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
    return json({ error: 'No backup available' }, 404);
  }

  const filename = `skinbase-backup-${user.username}.json`;
  const response = new Response(backup.backup_json, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });

  await env.DB.prepare(
    'DELETE FROM skin_backups WHERE user_id = ?'
  ).bind(user.id).run();

  return response;
}

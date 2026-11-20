import { getUser, json, isDeleteAdmin } from '../../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const user = await getUser(request, env);
  if (!user) {
    return json({ user: null });
  }

  // canDelete едет с пользователем, чтобы интерфейс не показывал кнопку сноса
  // тем, кому сервер всё равно ответит 403.
  return json({
    user: {
      id: user.id,
      username: user.username,
      canDelete: isDeleteAdmin(user),
      isAdmin: !!user.isAdmin,
      isSuperAdmin: !!user.isSuperAdmin
    }
  });
}

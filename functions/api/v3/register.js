import { hashPassword, generateSalt, generateToken } from '../../_lib/hash.js';
import { json, isDeleteAdmin, isAdminUsername, isSuperAdmin } from '../../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const body = await request.json();
  const { username, password } = body;

  if (!username || !password) {
    return json({ error: 'Username and password required' }, 400);
  }
  if (username.length < 3 || username.length > 24) {
    return json({ error: 'Username must be 3-24 characters' }, 400);
  }
  if (password.length < 6) {
    return json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ?'
  ).bind(username).first();

  if (existing) {
    return json({ error: 'Username already taken' }, 409);
  }

  const salt = generateSalt();
  const password_hash = salt + ':' + await hashPassword(password, salt);

  const info = await env.DB.prepare(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)'
  ).bind(username, password_hash).run();

  const userId = info.meta.last_row_id;

  await env.DB.prepare(
    'INSERT INTO equipped (user_id) VALUES (?)'
  ).bind(userId).run();

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).bind(userId, token, expiresAt).run();

  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // Регистрация физически не может выдать canDelete: новое имя заведомо не
  // из админского списка. Флаг всё же едет, чтобы у SPA был один и тот же
  // формат ответа на все три входа (login/register/me).
  // При регистрации возвращаем canDelete: на случай предназназначения админа в БД.
  const appointed = await isAdminUsername(env, username);
  const userObj = { username, isAdmin: appointed, isSuperAdmin: isSuperAdmin({ username }) };
  const response = json({
    user: { id: userId, username, canDelete: isDeleteAdmin(userObj), isAdmin: !!userObj.isAdmin, isSuperAdmin: !!userObj.isSuperAdmin }
  }, 201);
  response.headers.set(
    'Set-Cookie',
    `__session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`
  );

  return response;
}

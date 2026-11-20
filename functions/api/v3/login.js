import { hashPassword, generateToken } from '../../_lib/hash.js';
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

  const user = await env.DB.prepare(
    'SELECT id, username, password_hash FROM users WHERE username = ?'
  ).bind(username).first();

  if (!user) {
    return json({ error: 'Invalid username or password' }, 401);
  }

  const [salt, storedHash] = user.password_hash.split(':');
  const computedHash = await hashPassword(password, salt);

  if (computedHash !== storedHash) {
    return json({ error: 'Invalid username or password' }, 401);
  }

  user.isAdmin = await isAdminUsername(env, user.username);
  user.isSuperAdmin = isSuperAdmin(user);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).bind(user.id, token, expiresAt).run();

  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const response = json({
    user: { id: user.id, username: user.username, canDelete: isDeleteAdmin(user), isAdmin: !!user.isAdmin, isSuperAdmin: !!user.isSuperAdmin }
  });
  response.headers.set(
    'Set-Cookie',
    `__session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`
  );

  return response;
}

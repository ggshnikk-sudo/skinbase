import { getUser, json } from '../../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/__session=([^;]+)/);
  if (match) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(match[1]).run();
  }

  const response = json({ ok: true });
  response.headers.set(
    'Set-Cookie',
    '__session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  );
  return response;
}

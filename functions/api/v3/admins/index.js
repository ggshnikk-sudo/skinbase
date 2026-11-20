import { getUser, json, requireSuperAdmin } from '../../../_lib/auth.js';

const BUILTIN = ['ggshnikk', 'eonix', 'aurorabreeze'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const user = await getUser(request, env);
  const authErr = requireSuperAdmin(user);
  if (authErr) return withCors(authErr);

  if (request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(
        'SELECT username, granted_by, granted_at FROM admins ORDER BY granted_at DESC'
      ).all();
      return withCors(json({
        superAdmin: 'ggshnikk',
        builtin: BUILTIN,
        appointed: results || []
      }));
    } catch (e) {
      console.error('admins GET failed', e);
      return withCors(json({ error: 'Failed to list admins' }, 500));
    }
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return withCors(json({ error: 'Invalid JSON' }, 400)); }
    const username = String((body && body.username) || '').trim().toLowerCase();
    if (!username || username.length < 1 || username.length > 24) {
      return withCors(json({ error: 'Invalid username' }, 400));
    }
    if (!/^[a-z0-9_\-\.]+$/i.test(username)) {
      // allow common username chars; keep permissive but sane
    }
    try {
      await env.DB.prepare(
        'INSERT INTO admins (username, granted_by, granted_at) VALUES (?, ?, datetime("now")) ' +
        'ON CONFLICT(username) DO UPDATE SET granted_by=excluded.granted_by, granted_at=excluded.granted_at'
      ).bind(username, user.username).run();
      return withCors(json({ ok: true, admin: { username, granted_by: user.username } }));
    } catch (e) {
      console.error('admins POST failed', e);
      return withCors(json({ error: 'Failed to appoint admin' }, 500));
    }
  }

  return withCors(json({ error: 'Method not allowed' }, 405));
}

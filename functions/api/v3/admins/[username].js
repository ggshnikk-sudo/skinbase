import { getUser, json, requireSuperAdmin } from '../../../_lib/auth.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const user = await getUser(request, env);
  const authErr = requireSuperAdmin(user);
  if (authErr) return withCors(authErr);

  if (request.method !== 'DELETE') {
    return withCors(json({ error: 'Method not allowed' }, 405));
  }

  const username = String(params.username || '').trim().toLowerCase();
  if (!username) return withCors(json({ error: 'Invalid username' }, 400));

  try {
    await env.DB.prepare('DELETE FROM admins WHERE username = ? COLLATE NOCASE').bind(username).run();
    return withCors(json({ ok: true, removed: username }));
  } catch (e) {
    console.error('admins DELETE failed', e);
    return withCors(json({ error: 'Failed to remove admin' }, 500));
  }
}

import { getUser, json, isDeleteAdmin } from '../../_lib/auth.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  const c = corsHeaders();
  for (const [k, v] of Object.entries(c)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}


export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method === 'GET') {
    try {
      const row = await env.DB.prepare(
        'SELECT config_json, version, updated_at, updated_by FROM branding_config WHERE id = 1'
      ).first();
      if (!row) {
        return withCors(json({ version: 0, logoUrl: '', iconUrl: '', faviconUrl: '', brandName: '', themeCss: '' }));
      }
      let cfg = {};
      try { cfg = JSON.parse(row.config_json || '{}'); } catch {}
      cfg.version = row.version || cfg.version || 0;
      cfg.updatedAt = row.updated_at || cfg.updatedAt || null;
      return withCors(json(cfg));
    } catch (e) {
      console.error('branding GET failed', e);
      return withCors(json({ error: 'Failed to load branding config' }, 500));
    }
  }

  if (request.method === 'POST') {
    const user = await getUser(request, env);
    if (!user) return withCors(json({ error: 'Unauthorized' }, 401));
    if (!isDeleteAdmin(user)) return withCors(json({ error: 'Forbidden' }, 403));

    let body;
    try { body = await request.json(); } catch { return withCors(json({ error: 'Invalid JSON' }, 400)); }

    const incoming = (body && body.config && typeof body.config === 'object') ? body.config : (body || {});
    const config = {
      logoUrl: String(incoming.logoUrl || incoming.logo || '').slice(0, 2000000),
      iconUrl: String(incoming.iconUrl || incoming.icon || incoming.faviconUrl || incoming.favicon || '').slice(0, 2000000),
      faviconUrl: String(incoming.faviconUrl || incoming.favicon || incoming.iconUrl || incoming.icon || '').slice(0, 2000000),
      brandName: String(incoming.brandName || '').slice(0, 120),
      themeCss: String(incoming.themeCss || incoming.css || incoming.customCss || '').slice(0, 500000),
      themeCssUrl: String(incoming.themeCssUrl || incoming.cssUrl || '').slice(0, 2000),
    };
    const version = Date.now();
    const updatedAt = new Date().toISOString();
    const updatedBy = user.username;
    const configJson = JSON.stringify(config);

    try {
      await env.DB.prepare(
        'INSERT INTO branding_config (id, config_json, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by'
      ).bind(configJson, version, updatedAt, updatedBy).run();

      const out = { ...config, version, updatedAt, updatedBy };
      return withCors(json({ ok: true, config: out }));
    } catch (e) {
      console.error('branding POST failed', e);
      return withCors(json({ error: 'Failed to save branding config' }, 500));
    }
  }

  return withCors(json({ error: 'Method not allowed' }, 405));
}
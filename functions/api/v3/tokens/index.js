import { getUser, json, requireAuth } from '../../../_lib/auth.js';
import { generateApiToken, hashToken } from '../../../_lib/hash.js';

// API-токены пользователя.
// GET  /api/v3/tokens        — список токенов (без самих токенов)
// POST /api/v3/tokens {name} — создать токен (показывается один раз)
export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, name, created_at, last_used_at, revoked
       FROM api_tokens WHERE user_id = ?
       ORDER BY created_at DESC`
    ).bind(user.id).all();

    return json({ tokens: results.map(t => ({
      id: t.id,
      name: t.name,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      revoked: !!t.revoked
    })) });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || 'API').trim().slice(0, 50) || 'API';

    const token = generateApiToken();
    const tokenHash = await hashToken(token);

    const info = await env.DB.prepare(
      'INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, ?, ?)'
    ).bind(user.id, name, tokenHash).run();

    return json({
      token: {
        id: info.meta.last_row_id,
        name,
        token, // показывается один раз — сохраните его
        created_at: new Date().toISOString()
      },
      note: 'Токен показывается только один раз. Храните его в безопасном месте.'
    }, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
}

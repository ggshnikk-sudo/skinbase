import { getUser, json, requireAuth } from '../../../../_lib/auth.js';

function toPublic(a) {
  return {
    id: a.id,
    name: a.name,
    animated: true,
    tags: a.tags,
    created_at: a.created_at,
    url: `/api/animated/v1/skin-file/${a.id}.png`,
    file: a.value && a.value.startsWith('http') ? a.value : null
  };
}

// Каталог анимированных капов (Stacked PNG). Отдельная ветвь API animated/v1 —
// обычные капы живут в /api/v3 и сюда не попадают.
export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const search = url.searchParams.get('search');

  let query = 'SELECT id, name, value, tags, created_at FROM animated';
  const params = [];

  if (search) {
    query += ' WHERE (name LIKE ? OR tags LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY created_at DESC';

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ skins: results.map(toPublic) });
}
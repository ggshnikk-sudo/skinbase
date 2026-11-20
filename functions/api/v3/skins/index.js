import { getUser, json, requireAuth } from '../../../_lib/auth.js';

function toPublic(skin) {
  return {
    id: skin.id,
    name: skin.name,
    category: skin.category,
    tags: skin.tags,
    created_at: skin.created_at,
    url: `/api/v3/skin-file/${skin.id}.png`,
    file: skin.value && skin.value.startsWith('http') ? skin.value : null
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Общая библиотека: возвращаем ВСЕ капы всех пользователей (без границ «мой/чужой»)
  const url = new URL(request.url);
  const search = url.searchParams.get('search');

  let query = "SELECT id, name, category, value, tags, created_at FROM skins WHERE category = 'cape'";
  const params = [];

  if (search) {
    query += ' AND (name LIKE ? OR tags LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY created_at DESC';

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ skins: results.map(toPublic) });
}

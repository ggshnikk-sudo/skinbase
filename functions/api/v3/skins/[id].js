import { getUser, json, requireAuth, requireDeleteAdmin } from '../../../_lib/auth.js';
import { invalidateEquippedCache } from '../../../_lib/cache.js';
import { deleteStored } from '../../../_lib/storage.js';

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
  const { request, env, params } = context;
  const user = await getUser(request, env);
  const authError = requireAuth(user);
  if (authError) return authError;

  const id = Number(params.id.replace(/\.png$/i, ''));
  if (!Number.isInteger(id)) {
    return json({ error: 'Invalid skin id' }, 400);
  }

  const skin = await env.DB.prepare(
    "SELECT id, name, category, value, tags, created_at FROM skins WHERE id = ? AND category = 'cape'"
  ).bind(id).first();

  if (!skin) {
    return json({ error: 'Cape not found' }, 404);
  }

  if (request.method === 'GET') {
    return json({ skin: toPublic(skin) });
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    const { name, tags } = body;

    let query = 'UPDATE skins SET';
    const updates = [];
    const params = [];

    if (name !== undefined && typeof name === 'string') { updates.push(' name = ?'); params.push(name.trim()); }
    if (tags !== undefined && typeof tags === 'string') { updates.push(' tags = ?'); params.push(tags.trim()); }

    if (updates.length === 0) {
      return json({ error: 'No fields to update' }, 400);
    }

    query += updates.join(',') + ' WHERE id = ?';
    params.push(id);

    await env.DB.prepare(query).bind(...params).run();

    const updated = await env.DB.prepare(
      "SELECT id, name, category, value, tags, created_at FROM skins WHERE id = ?"
    ).bind(id).first();

    return json({ skin: toPublic(updated) });
  }

  if (request.method === 'DELETE') {
    // Проверка именно здесь, а не в requireAuth вверху: прочитать и править
    // плащ может любой, сносить — только админ.
    const adminError = requireDeleteAdmin(user);
    if (adminError) return adminError;

    // Файл сносим ДО записи в equipped: если он вдруг не удалится, обрыв
    // на equipped.cape_skin_id оставит игрока с несуществующим капом, и
    // починить это будет можно только вручную.
    await deleteStored(env, skin.value, async (value) => {
      // CatBox дедуплицирует файлы по содержимому: одинаковые капы могут
      // ссылаться на один файл — удаляем его только если он не нужен другим капам.
      const usage = await env.DB.prepare(
        'SELECT COUNT(*) AS cnt FROM skins WHERE value = ? AND id != ?'
      ).bind(value, id).first();
      return !usage || usage.cnt > 0;
    });

    await env.DB.prepare(
      'DELETE FROM skins WHERE id = ?'
    ).bind(id).run();

    await env.DB.prepare(
      'UPDATE equipped SET cape_skin_id = NULL WHERE cape_skin_id = ?'
    ).bind(id).run();

    await invalidateEquippedCache(request, user.username);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

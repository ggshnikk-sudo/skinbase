import { getUser, json, requireAuth, requireDeleteAdmin } from '../../../../_lib/auth.js';
import { invalidateAnimatedCache } from '../../../../_lib/cache.js';
import { deleteStored } from '../../../../_lib/storage.js';

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
    'SELECT id, name, value, tags, created_at FROM animated WHERE id = ?'
  ).bind(id).first();

  if (!skin) {
    return json({ error: 'Animated cape not found' }, 404);
  }

  if (request.method === 'GET') {
    return json({ skin: toPublic(skin) });
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    const { name, tags } = body;

    const query = 'UPDATE animated SET';
    const updates = [];
    const params = [];

    if (name !== undefined && typeof name === 'string') { updates.push(' name = ?'); params.push(name.trim()); }
    if (tags !== undefined && typeof tags === 'string') { updates.push(' tags = ?'); params.push(tags.trim()); }

    if (updates.length === 0) {
      return json({ error: 'No fields to update' }, 400);
    }

    await env.DB.prepare(query + ', updated_at = datetime("now") WHERE id = ?').bind(...params, id).run();

    const updated = await env.DB.prepare(
      'SELECT id, name, value, tags, created_at FROM animated WHERE id = ?'
    ).bind(id).first();

    await invalidateAnimatedCache(request, user.username);
    return json({ skin: toPublic(updated) });
  }

  if (request.method === 'DELETE') {
    // Проверка именно здесь, а не в requireAuth вверху: прочитать и править
    // анимированный плащ может любой, сносить — только админ.
    const adminError = requireDeleteAdmin(user);
    if (adminError) return adminError;

    // Файл сносим ДО записи в animated_equipped — иначе обрыв оставит
    // игрока со ссылкой на уже несуществующий стек.
    await deleteStored(env, skin.value, async (value) => {
      // CatBox дедуплицирует файлы по содержимому: удаляем только если файл
      // не нужен другим анимированным капам.
      const usage = await env.DB.prepare(
        'SELECT COUNT(*) AS cnt FROM animated WHERE value = ? AND id != ?'
      ).bind(value, id).first();
      return !usage || usage.cnt > 0;
    });

    await env.DB.prepare(
      'DELETE FROM animated WHERE id = ?'
    ).bind(id).run();

    await env.DB.prepare(
      'UPDATE animated_equipped SET animated_skin_id = NULL WHERE animated_skin_id = ?'
    ).bind(id).run();

    await invalidateAnimatedCache(request, user.username);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
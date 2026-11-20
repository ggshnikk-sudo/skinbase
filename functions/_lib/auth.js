import { hashToken } from './hash.js';

const BUILTIN_ADMINS = new Set(['ggshnikk', 'eonix', 'aurorabreeze']);
const SUPER_ADMIN = 'ggshnikk';

export function isSuperAdmin(user) {
  return !!user && typeof user.username === 'string' && user.username.toLowerCase() === SUPER_ADMIN;
}

export async function isAdminUsername(env, username) {
  if (typeof username !== 'string' || !username) return false;
  const lower = username.toLowerCase();
  if (BUILTIN_ADMINS.has(lower)) return true;
  try {
    const row = await env.DB.prepare(
      'SELECT 1 AS ok FROM admins WHERE username = ? COLLATE NOCASE'
    ).bind(lower).first();
    return !!row;
  } catch {
    // Таблица может отсутствовать до применения миграции — считаем не админом.
    return false;
  }
}

async function attachAdmin(user, env) {
  if (!user) return user;
  const lower = typeof user.username === 'string' ? user.username.toLowerCase() : '';
  const builtin = BUILTIN_ADMINS.has(lower);
  let appointed = false;
  if (!builtin) {
    appointed = await isAdminUsername(env, lower);
  }
  user.isAdmin = builtin || appointed;
  user.isSuperAdmin = lower === SUPER_ADMIN;
  return user;
}

async function findUser(env, where, ...args) {
  const user = await env.DB.prepare(
    `SELECT id, username, created_at FROM users WHERE ${where}`
  ).bind(...args).first();
  if (!user) return null;
  return attachAdmin(user, env);
}

// Аутентификация: cookie-сессия (браузер) или API-токен (Authorization: Bearer <token>).
export async function getUser(request, env) {
  // 1. Cookie-сессия
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/__session=([^;]+)/);
  if (match) {
    const session = await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime("now")'
    ).bind(match[1]).first();
    if (session) {
      const user = await findUser(env, 'id = ?', session.user_id);
      if (user) return user;
    }
  }

  // 2. Bearer-токен
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const tokenHash = await hashToken(token);
      const record = await env.DB.prepare(
        'SELECT user_id FROM api_tokens WHERE token_hash = ? AND revoked = 0'
      ).bind(tokenHash).first();
      if (record) {
        // Не блокируем обработку на обновлении счётчика: fire-and-forget.
        env.DB.prepare(
          'UPDATE api_tokens SET last_used_at = datetime("now") WHERE token_hash = ?'
        ).bind(tokenHash).run().catch(() => {});
        const user = await findUser(env, 'id = ?', record.user_id);
        if (user) return user;
      }
    }
  }

  return null;
}

// Обратная совместимость: явный алиас (только cookie в старом смысле не выделяем отдельно).
export async function getUserFromSession(request, env) {
  return getUser(request, env);
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function requireAuth(user) {
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

// Проверка: имеет ли пользователь полные админ-права (удаление/управление контентом/брендинг).
// GGSHNIKK, eonix, aurorabreeze — встроенные админы (совместимость), плюс админы, назначенные GGSHNIKK в БД.
export function isDeleteAdmin(user) {
  if (!user || typeof user.username !== 'string') return false;
  if (user.isAdmin === true) return true;
  return BUILTIN_ADMINS.has(user.username.toLowerCase());
}

export function requireDeleteAdmin(user) {
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!isDeleteAdmin(user)) {
    return json({ error: 'Forbidden' }, 403);
  }
  return null;
}

export function requireSuperAdmin(user) {
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!isSuperAdmin(user)) {
    return json({ error: 'Forbidden' }, 403);
  }
  return null;
}

// Кэш для /api/v3/equipped и /api/v3/skins/<user>/cape.png.
// Хранится только в caches.default (Worker) — НЕ кэшируем на edge через
// Cache-Control public/s-maxage, иначе инвалидация delete() не достанет
// до edge-кэша и игроки будут видеть устаревшие данные до часа.
// При каждой мутации (equip/unequip/удаление) кэш сбрасывается явно.

export const EQUIPPED_CACHE_TTL = 3600; // 1 час

// Ключ кэша — канонический URL эндпоинта (без query).
export function equippedCacheKey(request) {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

export async function getCachedEquipped(request) {
  return caches.default.match(equippedCacheKey(request));
}

export async function putCachedEquipped(request, response) {
  const res = response.clone();
  // private — edge/CDN не кэширует, только caches.default и браузер на 60 c
  res.headers.set('Cache-Control', 'private, max-age=60');
  return caches.default.put(equippedCacheKey(request), res);
}

// Вызывать из мутационных эндпоинтов анимированной ветки api/animated/v1.
// request — любой запрос; username — если менялась анимированная экипировка.
export async function invalidateAnimatedCache(request, username) {
  const url = new URL(request.url);
  const { protocol, host } = url;
  const targets = [
    `${protocol}//${host}/api/animated/v1/equipped`,
  ];
  if (username) {
    // cape.json тоже: в нём лежит ссылка на id КОНКРЕТНОГО капа, поэтому
    // без сброса клиент по ней продолжил бы запрашивать файл прежнего плаща.
    targets.push(
      `${protocol}//${host}/api/animated/v1/skins/${username}/cape.png`,
      `${protocol}//${host}/api/animated/v1/skins/${username}/cape.json`,
    );
  }
  try {
    await Promise.all(targets.map(async (target) => {
      await caches.default.delete(new Request(target, { method: 'GET' }));
    }));
  } catch (e) {
    // Инвалидация не должна ронять основной запрос
    console.warn('Animated cache invalidate failed:', e);
  }
}

// Вызывать из мутационных эндпоинтов после успешного изменения БД.
// request — любой запрос; username — если менялась экипировка капа
// (сбрасывает и PNG-кэш /api/v3/skins/<user>/cape.png).
export async function invalidateEquippedCache(request, username) {
  const url = new URL(request.url);
  const { protocol, host } = url;
  const targets = [
    `${protocol}//${host}/api/v3/equipped`,
  ];
  if (username) {
    // cape.json тоже: в нём лежит ссылка на id КОНКРЕТНОГО капа, поэтому
    // без сброса клиент по ней продолжил бы запрашивать файл прежнего плаща.
    targets.push(
      `${protocol}//${host}/api/v3/skins/${username}/cape.png`,
      `${protocol}//${host}/api/v3/skins/${username}/cape.json`,
    );
  }
  try {
    await Promise.all(targets.map(async (target) => {
      await caches.default.delete(new Request(target, { method: 'GET' }));
    }));
  } catch (e) {
    // Инвалидация не должна ронять основной запрос
    console.warn('Cache invalidate failed:', e);
  }
}

// Тесты политики кэша раздачи плащей.
//
// Регресс: игрок сменил плащ, а API continued отдавать старый. Причина —
// ссылка по ИМЕНИ игрока (/skins/<username>/cape.png) отдавалась с
// `Cache-Control: public`, edge Cloudflare клал её в кэш, и сбросить его из
// Worker невозможно: caches.default.delete() до edge не доходит.
//
// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_IMMUTABLE,
  CACHE_MUTABLE,
  proxyTextureFile
} from '../functions/_lib/catbox.js';
import {
  equippedCacheKey,
  invalidateAnimatedCache,
  invalidateEquippedCache
} from '../functions/_lib/cache.js';
import { onRequest as skinFileRoute } from '../functions/api/v3/skin-file/[id].js';

// Настоящая 8-байтовая сигнатура PNG. Фикстура обязана быть настоящей:
// раздача проверяет сигнатуру, иначе CatBox-ответ с чужим содержимым ушёл бы
// на клиент как картинка.
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]).buffer;

/**
 * Подмена globalThis.fetch: отдаёт заранее заданный ответ.
 *
 * Принимает и Response, и функцию-фабрику. Тело Response читается один раз,
 * а раздача теперь читает его целиком (так можно проверить сигнатуру), поэтому
 * на каждый вызов нужен свежий ответ — иначе второй запрос увидит уже
 * вычитанное тело и решит, что файл пустой.
 */
function stubFetch(response) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return typeof response === 'function' ? response() : response.clone();
  }
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const okPng = () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });

test('ссылка по имени игрока не кэшируется ни в edge, ни в браузере', async () => {
  const stub = stubFetch(okPng());
  try {
    const res = await proxyTextureFile('https://files.catbox.moe/a.png', {}, CACHE_MUTABLE);
    assert.equal(res.headers.get('Cache-Control'), CACHE_MUTABLE);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
  } finally {
    stub.restore();
  }
});

test('ссылка по id файла кэшируется — файл у id неизменяем', async () => {
  const stub = stubFetch(okPng());
  try {
    const res = await proxyTextureFile('https://files.catbox.moe/a.png', {}, CACHE_IMMUTABLE);
    assert.equal(res.headers.get('Cache-Control'), CACHE_IMMUTABLE);
    assert.match(res.headers.get('Cache-Control'), /public/);
    assert.doesNotMatch(res.headers.get('Cache-Control'), /no-store/);
  } finally {
    stub.restore();
  }
});

test('политика по умолчанию — постоянная ссылка, а не no-store', async () => {
  // Смена дефолта молча превратила бы все id-ссылки в no-store и убила кэш.
  const stub = stubFetch(okPng());
  try {
    const res = await proxyTextureFile('https://files.catbox.moe/a.png', {});
    assert.equal(res.headers.get('Cache-Control'), CACHE_IMMUTABLE);
  } finally {
    stub.restore();
  }
});

test('legacy-кап из KV отдаётся, а не 404 (ветка была недостижимой)', async () => {
  const requested = [];
  const env = { SKINS_KV: { get: async (k) => { requested.push(k); return PNG; } } };
  const res = await proxyTextureFile('kv:capes/abc', env, CACHE_MUTABLE);
  assert.notEqual(res, null, 'kv:-источник обязан отдавать картинку');
  assert.deepEqual(requested, ['capes/abc']);
  assert.equal(res.headers.get('Cache-Control'), CACHE_MUTABLE);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
});

test('битый ключ в KV даёт null, а не исключение', async () => {
  const env = { SKINS_KV: { get: async () => null } };
  assert.equal(await proxyTextureFile('kv:capes/nope', env, CACHE_MUTABLE), null);
});

test('CORS не теряется ни при одной из политик', async () => {
  const stub = stubFetch(okPng());
  try {
    for (const policy of [CACHE_MUTABLE, CACHE_IMMUTABLE]) {
      const res = await proxyTextureFile('https://files.catbox.moe/a.png', {}, policy);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    }
  } finally {
    stub.restore();
  }
});

test('пустой ответ CatBox не выдаётся за плащ', async () => {
  // Регресс на реальный баг: CatBox один раз ответил 200 с пустым телом, и
  // прокси переслал это клиенту как валидный PNG. Плащ выглядел «есть» —
  // 200, image/png, — а был пустым, и пустота уехала в кэш edge.
  const stub = stubFetch(() => new Response(null, {
    status: 200, headers: { 'Content-Type': 'image/png' }
  }));
  try {
    assert.equal(await proxyTextureFile('https://files.catbox.moe/a.png', {}), null);
  } finally {
    stub.restore();
  }
});

test('CatBox отдаёт не PNG — это тоже не картинка', async () => {
  const stub = stubFetch(() => new Response('<html>maintenance</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' }
  }));
  try {
    assert.equal(await proxyTextureFile('https://files.catbox.moe/a.png', {}), null);
  } finally {
    stub.restore();
  }
});

test('на обрезанный файл идёт повтор в обход кэша, а не отдача мусора', async () => {
  // Первая попытка может получить закэхированную на edge пустоту от прошлого
  // сбоя. Если CatBox на самом деле жив, повтор с новым ключом кэша приносит
  // файл — иначе такой застрявший кэш пришлось бы сбрасывать руками.
  const stub = stubFetch(() => new Response(null, {
    status: 200, headers: { 'Content-Type': 'image/png' }
  }));
  try {
    assert.equal(await proxyTextureFile('https://files.catbox.moe/a.png', {}), null);
    assert.equal(stub.calls.length, 2, 'ожидалась вторая попытка в обход кэша');
    assert.equal(stub.calls[0], 'https://files.catbox.moe/a.png');
    assert.notEqual(stub.calls[1], stub.calls[0], 'повтор обязан иметь другой ключ кэша');
  } finally {
    stub.restore();
  }
});

test('повтор чинит файл, если CatBox ожил', async () => {
  let call = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    return call === 1
      ? new Response(null, { status: 200, headers: { 'Content-Type': 'image/png' } })
      : new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  try {
    const res = await proxyTextureFile('https://files.catbox.moe/a.png', {});
    assert.ok(res, 'после повтора файл обязан отдаться');
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    assert.equal((await res.arrayBuffer()).byteLength, PNG.byteLength);
  } finally {
    globalThis.fetch = original;
  }
});

test('нормальный PNG повторно не перезапрашивается', async () => {
  const stub = stubFetch(okPng);
  try {
    const res = await proxyTextureFile('https://files.catbox.moe/a.png', {});
    assert.ok(res);
    assert.equal(stub.calls.length, 1, 'живой файл не должен перезапрашиваться');
  } finally {
    stub.restore();
  }
});

test('пустой файл из KV тоже не выдаётся за плащ', async () => {
  const env = { SKINS_KV: { get: async () => new ArrayBuffer(0) } };
  assert.equal(await proxyTextureFile('kv:capes/empty', env), null);
});

test('404 без файла не кэшируется, иначе сбой CatBox залипнет на edge', async () => {
  // Обработчик раздачи. Закешированный на edge 404 живёт часами и не даёт
  // заметить, что файл на CatBox появился.
  const stub = stubFetch(() => new Response(null, {
    status: 200, headers: { 'Content-Type': 'image/png' }
  }));
  const env = {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ value: 'https://files.catbox.moe/a.png' }) }) })
    }
  };
  try {
    const res = await skinFileRoute({
      request: new Request('https://s.gg/api/v3/skin-file/7.png'),
      env,
      params: { id: '7.png' }
    });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
  } finally {
    stub.restore();
  }
});

test('битая ссылка и недоступный CatBox дают null, а не 500', async () => {
  assert.equal(await proxyTextureFile(null, {}), null);
  assert.equal(await proxyTextureFile('', {}), null);
  assert.equal(await proxyTextureFile('ftp://x/a.png', {}), null);
  assert.equal(await proxyTextureFile('kv:none', { SKINS_KV: { get: async () => null } }), null);

  const stub = stubFetch(new Response('nope', { status: 500 }));
  try {
    assert.equal(await proxyTextureFile('https://files.catbox.moe/a.png', {}), null);
  } finally {
    stub.restore();
  }

  // fetch падает ИСКЛЮЧЕНИЕМ (обрыв сети), а не отвечает 5xx
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await proxyTextureFile('https://files.catbox.moe/a.png', {}), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('ключ кэша не зависит от query — иначе сброс кэша промахивался бы', async () => {
  const bare = new Request('https://s.gg/api/animated/v1/skins/GGSHNIKK/cape.png');
  const withQuery = new Request('https://s.gg/api/animated/v1/skins/GGSHNIKK/cape.png?t=123');
  assert.equal(equippedCacheKey(bare).url, equippedCacheKey(withQuery).url);
});

test('разные игроки и разные файлы не делят запись кэша', async () => {
  const key = (u, f) =>
    equippedCacheKey(new Request(`https://s.gg/api/animated/v1/skins/${u}/${f}`)).url;
  assert.notEqual(key('A', 'cape.png'), key('B', 'cape.png'));
  assert.notEqual(key('A', 'cape.png'), key('A', 'cape.json'));
});

/**
 * `caches` — глобал Workers, в Node его нет. Ставим заглушку и перехватываем
 * адреса, которые код пытается удалить.
 */
function installCachesStub() {
  const deleted = [];
  const original = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async () => undefined,
      put: async () => undefined,
      delete: async (req) => { deleted.push(req.url); return true; }
    }
  };
  return { deleted, restore() { globalThis.caches = original; } };
}

async function captureDeleted(request, fn) {
  const stub = installCachesStub();
  try {
    await fn(request);
    return stub.deleted;
  } finally {
    stub.restore();
  }
}

test('смена анимированного плаща сбрасывает и cape.png, и cape.json', async () => {
  const deleted = await captureDeleted(
    new Request('https://s.gg/api/animated/v1/equip'),
    (r) => invalidateAnimatedCache(r, 'GGSHNIKK')
  );
  assert.ok(deleted.includes('https://s.gg/api/animated/v1/skins/GGSHNIKK/cape.png'), deleted);
  assert.ok(
    deleted.includes('https://s.gg/api/animated/v1/skins/GGSHNIKK/cape.json'),
    'cape.json кэшируется на час и без сброса клиент продолжит брать id прежнего капа'
  );
  assert.ok(deleted.includes('https://s.gg/api/animated/v1/equipped'), deleted);
});

test('смена обычного плаща сбрасывает и cape.png, и cape.json', async () => {
  const deleted = await captureDeleted(
    new Request('https://s.gg/api/v3/equip'),
    (r) => invalidateEquippedCache(r, 'GGSHNIKK')
  );
  assert.ok(deleted.includes('https://s.gg/api/v3/skins/GGSHNIKK/cape.png'), deleted);
  assert.ok(deleted.includes('https://s.gg/api/v3/skins/GGSHNIKK/cape.json'), deleted);
  assert.ok(deleted.includes('https://s.gg/api/v3/equipped'), deleted);
});

test('инвалидация не ходит в чужие хосты и не падает без username', async () => {
  const deleted = await captureDeleted(
    new Request('https://s.gg/api/animated/v1/equip'),
    (r) => invalidateAnimatedCache(r, undefined)
  );
  assert.deepEqual(deleted, ['https://s.gg/api/animated/v1/equipped']);
});

// Тесты обвязки роутов раздачи плащей — того, что реально сломалось.
//
// Мутaция «вернуть CACHE_IMMUTABLE в алиасе по имени игрока» проходила тесты
// helpers, пока здесь не появилась проверка самих роутов: баг был именно в
// том, КАКОЙ политикой роут вызывал proxyTextureFile.
//
// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as animatedAlias } from '../functions/api/animated/v1/skins/[username]/[file].js';
import { onRequest as animatedById } from '../functions/api/animated/v1/skin-file/[id].js';
import { onRequest as v3Alias } from '../functions/api/v3/skins/[username]/[file].js';
import { onRequest as v3ById } from '../functions/api/v3/skin-file/[id].js';

// Настоящая 8-байтовая сигнатура PNG: раздача проверяет её, чтобы ответ
// CatBox с чужим содержимым не ушёл на клиент как картинка.
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]).buffer;
const CAPE = 'https://files.catbox.moe/cape.png';

/**
 * D1-заглушка. Отдаёт все нужные поля сразу: роут читает либо `id` (users),
 * либо `value` (skin-file по id), либо `cape_id`/`cape_value` (экипировка).
 */
function fakeEnv() {
  return {
    DB: {
      prepare() {
        return {
          bind: () => ({
            first: async () => ({ id: 7, value: CAPE, cape_id: 16, cape_value: CAPE }),
            run: async () => ({})
          })
        };
      }
    }
  };
}

/** Контекст Pages Function: params выводятся из пути, как это делает Pages. */
function fakeContext(path) {
  const done = [];
  const byId = /\/skin-file\/([^/]+)$/.exec(path);
  const alias = /\/skins\/([^/]+)\/([^/]+)$/.exec(path);
  const params = byId
    ? { id: byId[1] }
    : { username: alias[1], file: alias[2] };
  return {
    request: new Request(`https://s.gg${path}`),
    env: fakeEnv(),
    params,
    waitUntil: (p) => done.push(p),
    _done: done
  };
}

/** Окружение Workers, нужное роутам: fetch к CatBox и caches.default. */
function withRuntime(fn) {
  const saved = { fetch: globalThis.fetch, caches: globalThis.caches };
  globalThis.fetch = async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  // Настоящий кэш на Map, а не заглушка «всегда промах»: если роут начнёт
  // отдавать плащ из caches.default, тесты это поймают. Иначе регрессия
  // «старый плащ из кэша» прошла бы незаметно.
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url),
      put: async (req, res) => void store.set(req.url, res),
      delete: async (req) => store.delete(req.url)
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = saved.fetch;
      globalThis.caches = saved.caches;
    });
}

const CASES = [
  ['animated/v1', animatedAlias, '/api/animated/v1/skins/GGSHNIKK/cape.png'],
  ['v3', v3Alias, '/api/v3/skins/GGSHNIKK/cape.png']
];

for (const [name, onRequest, path] of CASES) {
  test(`${name}: ссылка по имени игрока отдаётся как no-store`, async () => {
    await withRuntime(async () => {
      const ctx = fakeContext(path);
      const res = await onRequest(ctx);
      assert.equal(res.status, 200);
      const cc = res.headers.get('Cache-Control');
      assert.match(cc, /no-store/, `алиас по имени игрока кэшируется: ${cc}`);
      await Promise.all(ctx._done);
    });
  });
}

for (const [name, onRequest] of [['animated/v1', animatedById], ['v3', v3ById]]) {
  test(`${name}: ссылка по id файла остаётся кэшируемой`, async () => {
    await withRuntime(async () => {
      const ctx = fakeContext('/api/x/skin-file/16.png');
      const res = await onRequest(ctx);
      assert.equal(res.status, 200);
      const cc = res.headers.get('Cache-Control');
      assert.match(cc, /public/, `id-ссылка не кэшируется: ${cc}`);
      assert.doesNotMatch(cc, /no-store/);
      await Promise.all(ctx._done);
    });
  });
}

for (const [name, onRequest, path] of CASES) {
  test(`${name}: cape.json отдаётся как no-store и указывает на id файла`, async () => {
    await withRuntime(async () => {
      const ctx = fakeContext(path.replace('cape.png', 'cape.json'));
      const res = await onRequest(ctx);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('Cache-Control') ?? '', /no-store/);
      const body = await res.json();
      assert.match(body.cape, /skin-file\/16\.png$/, 'клиент должен получать постоянную ссылку');
      await Promise.all(ctx._done);
    });
  });
}

test('анимированный: неизвестный игрок и неэкипированный кап дают 404, а не картинку', async () => {
  await withRuntime(async () => {
    const missing = fakeContext('/api/animated/v1/skins/GGSHNIKK/cape.png');
    missing.env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
    assert.equal((await animatedAlias(missing)).status, 404);
    await Promise.all(missing._done);

    const unequipped = fakeContext('/api/animated/v1/skins/GGSHNIKK/cape.png');
    unequipped.env = {
      DB: {
        prepare: (sql) => ({
          bind: () => ({ first: async () => (sql.includes('FROM users') ? { id: 7 } : null) })
        })
      }
    };
    assert.equal((await animatedAlias(unequipped)).status, 404);
  });
});

test('анимированный: метод не GET и неизвестное имя файла отклоняются', async () => {
  await withRuntime(async () => {
    const post = fakeContext('/api/animated/v1/skins/GGSHNIKK/cape.png');
    post.request = new Request('https://s.gg/api/animated/v1/skins/GGSHNIKK/cape.png', { method: 'POST' });
    assert.equal((await animatedAlias(post)).status, 405);

    const weird = fakeContext('/api/animated/v1/skins/GGSHNIKK/cape.png');
    weird.params = { username: 'GGSHNIKK', file: '../../secret' };
    assert.equal((await animatedAlias(weird)).status, 404);
  });
});

test('анимированный: битый CatBox даёт 404, а не прокси-ответ с прозрачной картинкой', async () => {
  await withRuntime(async () => {
    globalThis.fetch = async () => new Response('nope', { status: 502 });
    const res = await animatedAlias(fakeContext('/api/animated/v1/skins/GGSHNIKK/cape.png'));
    assert.equal(res.status, 404);
  });
});

/**
 * Регрессия на «старый плащ на 4 часа» — баг, который видел пользователь.
 * Адрес cape.png привязан к НИКУ, а не к id капа, и не меняется при смене
 * экипировки, поэтому единственная защита от залипания — каждый раз читать
 * текущую строку equipped. Проверяем именно это: меняем экипировку между двумя
 * запросами и требуем, чтобы второй ответ содержал НОВЫЙ плащ.
 *
 * Заодно проверяется cape.json: он обязан указать на новый id, иначе клиент,
 * идущий по id-ссылке (мод через type="json" + extract), продолжит тянуть
 * прежний кап.
 */
function equipState(capeId, capeValue) {
  return {
    DB: {
      prepare() {
        return {
          bind: () => ({
            first: async () => ({ id: 7, value: capeValue, cape_id: capeId, cape_value: capeValue }),
            run: async () => ({})
          })
        };
      }
    }
  };
}

for (const [name, onRequest, path] of CASES) {
  test(`${name}: смена экипировки сразу отдаёт новый плащ, а не предыдущий`, async () => {
    await withRuntime(async () => {
      // Каждому файлу на CatBox — свои байты, чтобы отличить старый плащ от нового.
      const files = {
        'https://files.catbox.moe/cape-a.png': new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xAA]),
        'https://files.catbox.moe/cape-b.png': new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xBB])
      };
      globalThis.fetch = async (url) => {
        const bytes = files[String(url)];
        return bytes
          ? new Response(bytes, { headers: { 'Content-Type': 'image/png' } })
          : new Response('nope', { status: 404 });
      };

      const first = fakeContext(path);
      first.env = equipState(16, 'https://files.catbox.moe/cape-a.png');
      const resA = await onRequest(first);
      assert.equal(resA.status, 200);
      assert.deepEqual(
        Buffer.from(await resA.arrayBuffer()),
        Buffer.from(files['https://files.catbox.moe/cape-a.png'])
      );
      await Promise.all(first._done);

      // Тот же URL, но пользователь уже переоделся в другой кап.
      const second = fakeContext(path);
      second.env = equipState(17, 'https://files.catbox.moe/cape-b.png');
      const resB = await onRequest(second);
      assert.equal(resB.status, 200);
      assert.deepEqual(
        Buffer.from(await resB.arrayBuffer()),
        Buffer.from(files['https://files.catbox.moe/cape-b.png']),
        'алиас по имени игрока отдал предыдущий плащ после смены экипировки'
      );
      await Promise.all(second._done);
    });
  });

  test(`${name}: cape.json после смены экипировки указывает на новый id`, async () => {
    await withRuntime(async () => {
      globalThis.fetch = async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
      const jsonPath = path.replace('cape.png', 'cape.json');

      const first = fakeContext(jsonPath);
      first.env = equipState(16, CAPE);
      assert.match((await (await onRequest(first)).json()).cape, /skin-file\/16\.png$/);
      await Promise.all(first._done);

      const second = fakeContext(jsonPath);
      second.env = equipState(17, CAPE);
      const body = await (await onRequest(second)).json();
      assert.match(body.cape, /skin-file\/17\.png$/, 'cape.json остался на прежнем id');
      await Promise.all(second._done);
    });
  });
}

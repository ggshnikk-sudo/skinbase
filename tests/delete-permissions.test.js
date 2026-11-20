// Кто может сносить плащи.
//
// Снос — единственное необратимое действие в проекте: удалённый кап и его
// файл на CatBox не вернуть, а пользователь считает удаление своей кнопкой и
// своей ошибкой. Раньше гейта не было вовсе: `requireAuth` пропускал любую
// залогиненную учётку, то есть снести плащ мог кто угодно из зарегстрированных.
//
// Загрузка и просмотр остаются доступны всем — ограничен только снос.
//
// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as deleteV3 } from '../functions/api/v3/skins/[id].js';
import { onRequest as deleteAnimated } from '../functions/api/animated/v1/skins/[id].js';
import { isDeleteAdmin, requireDeleteAdmin } from '../functions/_lib/auth.js';

const CAPE = 'https://files.catbox.moe/cape.png';
const HANDLERS = [
  ['v3', deleteV3, '/api/v3/skins/42.png'],
  ['animated', deleteAnimated, '/api/animated/v1/skins/42.png']
];

/**
 * D1-заглушка, которая помнит, что именно стёрли. Проверять надо, что запрет
 * случается ДО удаления строки: иначе 403 отдаётся, а плащ уже удалён.
 */
function fakeEnv({ username = 'Intruder', sessionToken = 'test-token' } = {}) {
  const log = [];
  const skins = new Map([[42, { id: 42, name: 'Кап', value: CAPE, tags: null }]]);

  return {
    log,
    skins,
    CATBOX_USERHASH: 'hash',
    DB: {
      prepare(sql) {
        const q = sql.replace(/\s+/g, ' ').trim();
        log.push(q);
        return {
          bind: (...args) => ({
            first: async () => {
              if (q.includes('FROM sessions')) return { user_id: 1 };
              if (q.includes('FROM users')) return { id: 1, username };
              if (q.startsWith('SELECT id, name')) return skins.get(args[0]) ?? null;
              if (q.includes('COUNT(*)')) return { cnt: 0 };
              return null;
            },
            run: async () => {
              if (q.startsWith('DELETE FROM')) {
                const table = /DELETE FROM (\w+)/.exec(q)[1];
                const key = table === 'skins' ? 'skins' : 'animated';
                skins.delete(args[0]);
                log.push(`deleted:${key}:${args[0]}`);
              }
              return {};
            }
          })
        };
      }
    },
    _sessionToken: sessionToken
  };
}

function delContext(env, { method = 'DELETE' } = {}) {
  const request = new Request('https://s.gg/api/v3/skins/42.png', { method });
  request.headers.set('Cookie', `__session=${env._sessionToken}`);
  return { request, env, params: { id: '42.png' }, waitUntil: () => {} };
}

/** fetch нужен catboxDelete и invalidate; счётчики удалённых URL — в out. */
function withRuntime(fn) {
  const saved = { fetch: globalThis.fetch, caches: globalThis.caches };
  const out = { catboxDeletes: 0, cacheDeletes: 0 };
  globalThis.fetch = async (url, init = {}) => {
    if (init.body instanceof FormData && init.body.get('reqtype') === 'deletefiles') {
      out.catboxDeletes++;
    }
    return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
  };
  globalThis.caches = {
    default: {
      match: async () => undefined,
      put: async () => {},
      delete: async () => { out.cacheDeletes++; return true; }
    }
  };
  return Promise.resolve()
    .then(() => fn(out))
    .finally(() => {
      globalThis.fetch = saved.fetch;
      globalThis.caches = saved.caches;
    });
}

for (const [label, handler, path] of HANDLERS) {
  test(`${label}: удалить плащ может только админ`, async () => {
    const cases = [
      ['Intruder', 403, 'чужая учётка'],
      ['Eonix', 200, 'админ'],
      ['EONIX', 200, 'админ в другом регистре'],
      ['GGSHNIKK', 200, 'владелец'],
      ['AuroraBreeze', 200, 'владелица']
    ];

    for (const [username, expected, who] of cases) {
      await withRuntime(async () => {
        const env = fakeEnv({ username });
        const res = await handler(delContext(env));
        assert.equal(res.status, expected, `${who} (${username}) должен получить ${expected}`);

        // Запрет обязан срабатывать ДО удаления строки и ДО сноса файла.
        if (expected === 403) {
          assert.equal(env.skins.has(42), true, `${who}: плащ не должен исчезнуть при 403`);
          assert.equal(env.log.some(q => q.startsWith('deleted:')), false,
            `${who}: DELETE в БД не должен выполняться`);
        } else {
          assert.equal(env.skins.has(42), false, `${who}: плащ должен исчезнуть при 200`);
        }
      });
    }
  });

  test(`${label}: неавторизованному отдаём 401, а не 403`, async () => {
    await withRuntime(async () => {
      const env = fakeEnv();
      const request = new Request('https://s.gg/api/v3/skins/42.png', { method: 'DELETE' });
      // Пустая кука: сессии нет вовсе.
      const res = await handler({ request, env, params: { id: '42.png' }, waitUntil: () => {} });
      assert.equal(res.status, 401);
      assert.equal(env.skins.has(42), true);
    });
  });

  test(`${label}: чтение и правка для чужих остаются доступны`, async () => {
    // Гейт только на снос. Если бы requireDeleteAdmin стоял в requireAuth
    // вверху файла, чужие не смогли бы даже посмотреть плащ — это поломка
    // галереи, а не ограничение удаления.
    await withRuntime(async () => {
      const env = fakeEnv({ username: 'Intruder' });
      const res = await handler(delContext(env, { method: 'GET' }));
      assert.equal(res.status, 200);
      assert.equal((await res.json()).skin.name, 'Кап');
    });
  });
}

test('список админов не спутывает похожие имена', async () => {
  // Подгонка под «нужное» имя — ровно тот обход, ради которого гейт и пишется.
  const impostors = ['ggshnikk1', 'ggshnik', 'ggshnikkk', 'eonix2', 'aurora', 'admin', ''];
  for (const username of impostors) {
    assert.equal(isDeleteAdmin({ username }), false, `«${username}» не должен считаться админом`);
  }
  assert.equal(isDeleteAdmin(null), false, 'без пользователя никто не админ');
  assert.equal(isDeleteAdmin({}), false, 'пользователь без username — не админ');
});

test('requireDeleteAdmin отдаёт 401 без пользователя и 403 для не-админа', async () => {
  assert.equal((await requireDeleteAdmin(null)).status, 401);
  assert.equal((await requireDeleteAdmin({ username: 'Intruder' })).status, 403);
  assert.equal(await requireDeleteAdmin({ username: 'GGSHNIKK' }), null);
});

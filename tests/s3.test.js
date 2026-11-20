// S3-совместимое хранилище: подпись SigV4, загрузка, выбор бэкенда.
//
// Подпись проверяется не «сам на себя», а против официального тест-вектора
// aws-sig-v4-test-suite: подпись, которую нельзя воспроизвести по эталону,
// нельзя отличить от правильной — она выглядит одинаково.
//
// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isS3File, s3Configured, s3Delete, s3KeyFromUrl, s3PublicUrl,
  s3Upload, sha256Hex, signRequest
} from '../functions/_lib/s3.js';
import {
  capeStorageKind, deleteStored, uploadCape as uploadCapeTo
} from '../functions/_lib/storage.js';
import { onRequest as uploadHandler } from '../functions/api/v3/upload.js';

const ENV = {
  S3_ENDPOINT: 'https://uefqmxajdzeyakvatyby.storage.supabase.co/storage/v1/s3',
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'capes',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret-example',
  S3_PUBLIC_BASE: 'https://uefqmxajdzeyakvatyby.supabase.co/storage/v1/object/public/capes'
};

// ─── Подпись SigV4 ───

test('SigV4 совпадает с официальным вектором aws-sig-v4-test-suite', async () => {
  // Вектор get-vanilla: GET /, без тела, сервис строкой "service".
  const signed = await signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    payloadHash: await sha256Hex(''),
    now: new Date('2015-08-30T12:36:00Z')
  });
  assert.match(
    signed.authorization,
    /Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/
  );
  assert.equal(signed.signedHeaders, 'host;x-amz-date');
  assert.equal(signed.scope, '20150830/us-east-1/service/aws4_request');
});

test('подпись меняется вместе с секретом и датой', async () => {
  const base = {
    method: 'PUT',
    url: 'https://example.amazonaws.com/capes/a.png',
    region: 'eu-central-1',
    accessKeyId: 'AK',
    secretAccessKey: 'secret-one',
    now: new Date('2015-08-30T12:36:00Z')
  };
  const sig = async (over) => (await signRequest({ ...base, ...over })).authorization;
  const one = await sig({});
  assert.notEqual(one, await sig({ secretAccessKey: 'secret-two' }));
  assert.notEqual(one, await sig({ now: new Date('2016-08-30T12:36:00Z') }));
  assert.notEqual(one, await sig({ region: 'us-east-1' }));
  assert.notEqual(one, await sig({ url: 'https://example.amazonaws.com/capes/b.png' }));
});

test('sha256 пустого тела — константа из спецификации', async () => {
  assert.equal(
    await sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});

// ─── Ссылки и включённость ───

test('S3 считается настроенным только целиком', () => {
  assert.equal(s3Configured(ENV), true);
  for (const key of Object.keys(ENV)) {
    const partial = { ...ENV };
    delete partial[key];
    assert.equal(s3Configured(partial), false, `без ${key} хранилище выключено`);
  }
  assert.equal(s3Configured({}), false);
});

test('публичная ссылка собирается и разбирается обратно', () => {
  const url = s3PublicUrl(ENV, 'capes/2024/x1.png');
  assert.equal(url, ENV.S3_PUBLIC_BASE + '/capes/2024/x1.png');
  assert.equal(isS3File(url, ENV), true);
  assert.equal(s3KeyFromUrl(url, ENV), 'capes/2024/x1.png');
});

test('ключ со спецсимволами кодируется и разбирается без потерь', () => {
  // Пробел и кириллица в ключе: если разбор вернёт другое имя, удалить файл
  // будет нечем, и он останется в бакете навсегда.
  const key = 'capes/Долбаёбы ыы.png';
  const url = s3PublicUrl(ENV, key);
  assert.ok(url.includes('%D0%94'), 'кириллица обязана быть percent-encoded');
  assert.ok(!url.includes(' '), 'пробел не должен попасть в URL');
  assert.equal(s3KeyFromUrl(url, ENV), key);
});

test('чужой URL не считается нашим файлом', () => {
  assert.equal(isS3File('https://files.catbox.moe/a.png', ENV), false);
  assert.equal(isS3File(ENV.S3_PUBLIC_BASE.replace('/capes', '/other') + '/a.png', ENV), false);
  assert.equal(s3KeyFromUrl('https://files.catbox.moe/a.png', ENV), null);
});

test('isS3File переживает мусорные значения и ненастроенное окружение', () => {
  // value приходит из D1 и в общем случае является непроверенной строкой, а
  // окружение может быть не настроено (S3 выключен). Ни то, ни другое не
  // должно ронять разбор ссылки.
  assert.equal(isS3File(null, ENV), false);
  assert.equal(isS3File(undefined, ENV), false);
  assert.equal(isS3File(42, ENV), false);
  assert.equal(isS3File({}, ENV), false);
  assert.equal(isS3File('', ENV), false);
  // Ненастроенное окружение не имеет смысла превращать чужие ссылки в «свои».
  assert.equal(isS3File(ENV.S3_PUBLIC_BASE + '/capes/a.png', {}), false);
  assert.equal(s3KeyFromUrl(ENV.S3_PUBLIC_BASE + '/capes/a.png', {}), null);
});

// ─── Загрузка ───

/** Настоящий PNG: заглушки, отдающие нули, честно отвергаются проверкой формата. */
function pngBytes(totalBytes = 512) {
  const b = new Uint8Array(totalBytes);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 64);
  view.setUint32(20, 32);
  b[24] = 8;
  b[25] = 6;
  return b;
}

/** S3-заглушка: помнит методы, умеет отдавать ошибки и занижать Content-Length. */
function stubS3({
  putStatus = 200,
  putFailTimes = null,
  headStatus = 200,
  headLength = null
} = {}) {
  // Если просят ошибку PUT, она должна быть на каждой попытке, а не на первой.
  const failures = putFailTimes ?? (putStatus === 200 ? 0 : Number.POSITIVE_INFINITY);
  const original = globalThis.fetch;
  const calls = [];
  let puts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url: u, init });

    if (method === 'PUT') {
      puts += 1;
      if (puts <= failures) return new Response('upstream busy', { status: putStatus });
      return new Response('', { status: 200 });
    }
    if (method === 'HEAD') {
      if (headStatus !== 200) return new Response('', { status: headStatus });
      return new Response(null, {
        status: 200,
        headers: { 'Content-Length': String(headLength ?? 512) }
      });
    }
    return new Response('', { status: 404 });
  };
  return { calls, puts: () => puts, restore: () => { globalThis.fetch = original; } };
}

test('загрузка подписывается и возвращает публичную ссылку', async () => {
  const s3 = stubS3();
  try {
    const url = await s3Upload(ENV, new Uint8Array(512), 'capes/a.png');

    assert.equal(url, ENV.S3_PUBLIC_BASE + '/capes/a.png');
    const put = s3.calls.find((c) => c.method === 'PUT');
    assert.equal(put.url, ENV.S3_ENDPOINT + '/capes/capes/a.png');
    assert.match(put.init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    assert.match(put.init.headers.Authorization, /\/eu-central-1\/s3\/aws4_request/);
    assert.ok(put.init.headers['x-amz-content-sha256'], 'S3 требует хеш тела');
    assert.equal(put.init.headers['content-type'], 'image/png');
    // Host подписывается, но в запросе не выставляется: Worker формирует его сам.
    assert.equal(put.init.headers.host, undefined);
    assert.equal(s3.calls.filter((c) => c.method === 'HEAD').length, 1);
  } finally {
    s3.restore();
  }
});

test('ошибка 4xx не повторяется — запрос неправильный, а не временный', async () => {
  const s3 = stubS3({ putStatus: 403 });
  try {
    await assert.rejects(
      () => s3Upload(ENV, new Uint8Array(512), 'capes/a.png'),
      /s3 403/
    );
    assert.equal(s3.puts(), 1, 'к AccessDenied второй раз ходить бессмысленно');
  } finally {
    s3.restore();
  }
});

test('ошибка 5xx повторяется и потом падает', async () => {
  const s3 = stubS3({ putStatus: 503 });
  try {
    await assert.rejects(
      () => s3Upload(ENV, new Uint8Array(512), 'capes/a.png'),
      /не принял файл после 3 попыток/
    );
    assert.equal(s3.puts(), 3);
  } finally {
    s3.restore();
  }
});

test('объект не той длины, что заливали, не считается успехом', async () => {
  // CatBox отдаёт ссылку, за которой пустота; тут та же идея на уровне HEAD:
  // залили 512 байт, а бакет отдал другой размер — плащ в галерее будет битый.
  const s3 = stubS3({ headLength: 12 });
  try {
    await assert.rejects(
      () => s3Upload(ENV, new Uint8Array(512), 'capes/a.png'),
      /вместо 512/
    );
    const deletes = s3.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 3, 'каждая неудачная попытка обязана убрать свой мусор');
    assert.ok(deletes[0].init.headers.Authorization, 'удаление тоже подписывается');
  } finally {
    s3.restore();
  }
});

test('объект, не открытый на чтение, не проходит проверку', async () => {
  const s3 = stubS3({ headStatus: 400 });
  try {
    await assert.rejects(() => s3Upload(ENV, new Uint8Array(512), 'capes/a.png'), /HTTP 400/);
  } finally {
    s3.restore();
  }
});

test('удаление переживает отсутствующий ключ', async () => {
  const s3 = stubS3();
  try {
    await s3Delete(ENV, 'capes/gone.png');
    const del = s3.calls.find((c) => c.method === 'DELETE');
    assert.ok(del.init.headers.Authorization);
  } finally {
    s3.restore();
  }
});

// ─── Выбор хранилища ───

test('без S3 загрузка идёт в CatBox', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/user/api.php')) {
      return new Response('https://files.catbox.moe/cape123.png', { status: 200 });
    }
    return new Response(pngBytes(512), { headers: { 'Content-Type': 'image/png' } });
  };
  try {
    const { value, storage } = await uploadCapeTo({ CATBOX_USERHASH: 'hash' }, pngBytes(512));
    assert.equal(value, 'https://files.catbox.moe/cape123.png');
    assert.equal(storage, 'catbox');
    assert.equal(capeStorageKind({ CATBOX_USERHASH: 'hash' }), 'catbox');
    assert.ok(seen.some((u) => u.includes('catbox.moe/user/api.php')));
  } finally {
    globalThis.fetch = original;
  }
});

test('сработавший резерв не считается успехом CatBox', async () => {
  // CatBox отдаёт «412 Invalid uploader» — ровно три цифры. Снаружи это ошибка,
  // а не файл, и пользователю без разницы, кто виноват: плащ должен залиться.
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('catbox.moe/user/api.php')) return new Response('412: Invalid uploader', { status: 412 });
    if (method === 'PUT') return new Response('', { status: 200 });
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': '512' } });
    }
    return new Response('', { status: 404 });
  };
  try {
    const { value, storage } = await uploadCapeTo(ENV, pngBytes(512));
    assert.equal(storage, 's3');
    assert.ok(value.startsWith(ENV.S3_PUBLIC_BASE + '/capes/'), 'в D1 лежит ссылка бакета: ' + value);
  } finally {
    globalThis.fetch = original;
  }
});

test('при резерве CatBox пробуется один раз, а не три', async () => {
  // Три попытки в заведомо провалившийся сервис — это минута ожидания
  // пользователя ради гарантированного успеха по второму пути.
  const original = globalThis.fetch;
  let catboxPosts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('catbox.moe/user/api.php')) { catboxPosts += 1; return new Response('412', { status: 412 }); }
    if (method === 'PUT') return new Response('', { status: 200 });
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': '512' } });
    }
    return new Response('', { status: 404 });
  };
  try {
    await uploadCapeTo(ENV, pngBytes(512));
    assert.equal(catboxPosts, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('без резерва ошибка CatBox доходит до клиента как есть', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('catbox.moe/user/api.php')) {
      return new Response('412: Invalid uploader', { status: 412 });
    }
    return new Response('', { status: 404 });
  };
  try {
    await assert.rejects(
      () => uploadCapeTo({ CATBOX_USERHASH: 'hash' }, pngBytes(512)),
      /catbox api error 412/
    );
    await assert.rejects(
      () => uploadCapeTo({ CATBOX_USERHASH: 'hash' }, pngBytes(512)),
      (e) => !/оба хранилища/.test(e.message),
      'без резерва нельзя говорить «оба хранилища отказали» — отказало одно'
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('когда отказали оба — в ошибке видны обе причины', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('catbox.moe/user/api.php')) return new Response('412: Invalid uploader', { status: 412 });
    if (method === 'PUT') return new Response('bucket missing', { status: 404 });
    return new Response('', { status: 404 });
  };
  try {
    await assert.rejects(
      () => uploadCapeTo(ENV, pngBytes(512)),
      (e) => /оба хранилища отказали/.test(e.message)
        && /catbox/.test(e.message) && /s3 404/.test(e.message),
      'в сообщении должны быть обе причины: ' + 'см. лог'
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('рабочий CatBox не заставляет трогать резерв', async () => {
  // Резерв включается по отказу, а не всегда: пока CatBox отвечает, лишних
  // запросов в бакет уходить не должно.
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    urls.push(`${(init.method || 'GET').toUpperCase()} ${u}`);
    if (u.includes('/user/api.php')) {
      return new Response('https://files.catbox.moe/cape123.png', { status: 200 });
    }
    return new Response(pngBytes(512), { headers: { 'Content-Type': 'image/png' } });
  };
  try {
    assert.equal(capeStorageKind(ENV), 's3', 'резерв настроен');
    const { value, storage } = await uploadCapeTo(ENV, pngBytes(512));
    assert.equal(storage, 'catbox');
    assert.equal(value, 'https://files.catbox.moe/cape123.png');
    assert.deepEqual(
      urls.filter((u) => u.includes('supabase.co')),
      [],
      'при живом CatBox в бакет не ходим'
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('живой CatBox: плащ попадает и в ссылку, и в альбом', async () => {
  // Обратная сторона фолбэка: пока CatBox отвечает, поведение прежнее —
  // ссылка catbox'овская и запрос addtoalbum уходит.
  const original = globalThis.fetch;
  const forms = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/user/api.php')) {
      if (init.body instanceof FormData) forms.push(init.body.get('reqtype'));
      return new Response('https://files.catbox.moe/cape123.png', { status: 200 });
    }
    return new Response(pngBytes(512), { headers: { 'Content-Type': 'image/png' } });
  };
  const rows = new Map();
  let lastRowId = 0;
  const env = {
    ...ENV,
    CATBOX_USERHASH: 'hash',
    CATBOX_ALBUM: 'album123',
    DB: {
      prepare: (sql) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        return {
          bind: (...args) => ({
            run: async () => {
              if (q.startsWith('INSERT INTO skins')) {
                const id = ++lastRowId;
                rows.set(id, { value: args[2] });
                return { meta: { last_row_id: id } };
              }
              return {};
            },
            first: async () =>
              q.includes('FROM sessions') ? { user_id: 1 } : { id: 1, username: 'GG' }
          })
        };
      }
    }
  };
  try {
    const form = new FormData();
    form.set('file', new File([pngBytes(512)], 'cape.png', { type: 'image/png' }));
    form.set('name', 'Плащ');
    const request = new Request('https://s.gg/api/v3/upload', { method: 'POST', body: form });
    request.headers.set('Cookie', '__session=test-token');

    const background = [];
    const res = await uploadHandler({
      request, env, params: {}, waitUntil: (p) => background.push(p)
    });
    await Promise.allSettled(background);

    const body = await res.clone().json();
    assert.equal(res.status, 201);
    assert.equal(body.skin.storage, 'catbox');
    assert.equal(rows.get(body.skin.id).value, 'https://files.catbox.moe/cape123.png');
    assert.ok(forms.includes('addtoalbum'), 'при живом CatBox альбом должен пополняться');
  } finally {
    globalThis.fetch = original;
  }
});

test('удаление S3-файла не спрашивает про занятость', async () => {
  // Проверка inUse существует ради дедупликации CatBox: там один файл могут
  // делить два плаща. У S3 ключ уникален на каждую загрузку, поэтому та же
  // проверка была бы лишним запросом к базе при каждом удалении.
  const s3 = stubS3();
  try {
    let inUseCalled = false;
    const value = s3PublicUrl(ENV, 'capes/a.png');
    await deleteStored(ENV, value, async () => { inUseCalled = true; return true; });
    assert.equal(inUseCalled, false);
    assert.equal(s3.calls.filter((c) => c.method === 'DELETE').length, 1);
  } finally {
    s3.restore();
  }
});

test('удаление CatBox-файла по-прежнему спрашивает про занятость', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('OK', { status: 200 }); };
  try {
    let asked = false;
    await deleteStored({ CATBOX_USERHASH: 'hash' }, 'https://files.catbox.moe/a.png', async () => {
      asked = true;
      return true;
    });
    assert.equal(asked, true);
    assert.deepEqual(seen, [], 'файл ещё нужен — удалять нельзя');
  } finally {
    globalThis.fetch = original;
  }
});

// ─── Интеграция с handler ───

test('handler пишет в D1 публичную ссылку S3', async () => {
  const s3 = stubS3();
  const rows = new Map();
  let lastRowId = 0;
  const env = {
    ...ENV,
    CATBOX_USERHASH: 'hash',
    CATBOX_ALBUM: 'album123',
    DB: {
      prepare: (sql) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        // auth.js после bind() зовёт first(), а запись метаданных — run():
        // заглушка обязана уметь и то и другое, иначе 500 приходит из неё.
        return {
          bind: (...args) => ({
            run: async () => {
              if (q.startsWith('INSERT INTO skins')) {
                const id = ++lastRowId;
                rows.set(id, { name: args[1], value: args[2] });
                return { meta: { last_row_id: id } };
              }
              return {};
            },
            first: async () => {
              if (q.includes('FROM sessions')) return { user_id: 1 };
              return { id: 1, username: 'GG' };
            }
          })
        };
      }
    }
  };
  try {
    const png = pngBytes(512);

    const form = new FormData();
    form.set('file', new File([png], 'cape.png', { type: 'image/png' }));
    form.set('name', 'Плащ');
    const request = new Request('https://s.gg/api/v3/upload', { method: 'POST', body: form });
    request.headers.set('Cookie', '__session=test-token');

    // Фоновые задачи надо дождаться: запрос в альбом уходит из waitUntil, и
    // без await заглушка не успевает его записать — тест проходит, а обход
    // альбома на самом деле случается.
    const background = [];
    const res = await uploadHandler({
      request, env, params: {}, waitUntil: (p) => background.push(p)
    });
    await Promise.allSettled(background);

    assert.equal(res.status, 201);
    const body = await res.clone().json();

    assert.equal(body.skin.storage, 's3');
    assert.ok(
      body.skin.value.startsWith(ENV.S3_PUBLIC_BASE + '/capes/'),
      'в D1 лежит публичная ссылка бакета: ' + body.skin.value
    );
    assert.equal(rows.get(body.skin.id).value, body.skin.value);

    // CatBox был попробован первым — именно на его отказе включился резерв.
    const catboxPosts = s3.calls.filter((c) => c.url.includes('catbox.moe/user/api.php'));
    assert.equal(catboxPosts.length, 1, 'основной путь должен быть пройден до резервного');

    // Альбом есть только у CatBox, и сработал резерв — значит запроса быть не
    // должно, иначе в альбом попал бы файл, которого там нет.
    const albumAdds = s3.calls.filter(
      (c) => c.init.body instanceof FormData && c.init.body.get('reqtype') === 'addtoalbum'
    );
    assert.deepEqual(albumAdds, [], 'файл лёг не в CatBox — в альбом его добавлять нельзя');
  } finally {
    s3.restore();
  }
});
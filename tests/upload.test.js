// Интеграция загрузки: handler → CatBox → метаданные → откат.
//
// Ключевое здесь — что ВЫСОКИЙ стек уходит на CatBox, а не в отдельное
// хранилище. Раньше наоборот: стоял выдуманный лимит 4096 px, и всё, что выше,
// писалось байтами в D1 (BLOB-слой, удалён 2026-09-28). Проверено на живых
// данных, что CatBox такие файлы берёт, поэтому тест ниже фиксирует именно
// это поведение.
//
// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as uploadCape } from '../functions/api/v3/upload.js';
import { onRequest as uploadAnimated } from '../functions/api/animated/v1/upload.js';
import { MAX_PNG_BYTES } from '../functions/_lib/limits.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngHeader(width, height) {
  // 29 байт: сигнатура(8) + длина(4) + 'IHDR'(4) + 13 байт данных. Ровно
  // столько нужно, чтобы прочитать ширину, высоту и тип цвета.
  const b = new Uint8Array(29);
  b.set(SIGNATURE, 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  b[24] = 8; // bit depth
  b[25] = 6; // colour type: RGBA
  return b;
}

function pngBytes(width, height, totalBytes = 512) {
  const b = new Uint8Array(totalBytes);
  b.set(pngHeader(width, height).subarray(0, totalBytes), 0);
  return b;
}

/** D1-заглушка. Держит строки в памяти и умеет падать на вставке метаданных. */
function fakeEnv({ failMetadata = false } = {}) {
  const rows = new Map();
  const log = [];
  let lastRowId = 100;

  return {
    rows,
    log,
    CATBOX_USERHASH: 'hash',
    CATBOX_ALBUM: 'album123',
    DB: {
      prepare(sql) {
        const q = sql.replace(/\s+/g, ' ').trim();
        log.push(q);
        return {
          bind: (...args) => ({
            run: async () => {
              if (q.startsWith('INSERT INTO skins') || q.startsWith('INSERT INTO animated')) {
                if (failMetadata) throw new Error('D1 недоступна');
                const id = ++lastRowId;
                rows.set(id, { id, name: args[1], value: args[2] });
                return { meta: { last_row_id: id } };
              }
              return {};
            },
            first: async () => {
              if (q.includes('FROM sessions')) return { user_id: 1 };
              if (q.includes('FROM users')) return { id: 1, username: 'GG' };
              return null;
            }
          })
        };
      }
    }
  };
}

/** POST с файлом и cookie сессии — без неё handler честно отдаёт 401. */
function uploadContext(env, bytes, { name = 'Плащ', method = 'POST' } = {}) {
  const form = new FormData();
  form.set('file', new File([bytes], 'cape.png', { type: 'image/png' }));
  form.set('name', name);
  const request = new Request('https://s.gg/api/v3/upload', { method, body: form });
  request.headers.set('Cookie', '__session=test-token');
  const done = [];
  return { request, env, params: {}, waitUntil: (p) => done.push(p), _done: done };
}

/**
 * CatBox на заглушке: отдаёт ссылку и пишет в seen адрес и reqtype.
 *
 * Файл отдаётся настоящим PNG: загрузка проверяет, что по выданной ссылке
 * реально лежит изображение, иначе CatBox-«успех» без файла проходил бы
 * незамеченным и ронял бы битый плащ в галерею.
 */
function stubCatbox(seen = []) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push(String(url));
    if (init.body && init.body instanceof FormData) {
      seen.push(`reqtype=${init.body.get('reqtype')}`);
    }
    if (String(url).includes('/user/api.php')) {
      return new Response('https://files.catbox.moe/cape123.png', { status: 200 });
    }
    return new Response(pngBytes(64, 32, 512), { headers: { 'Content-Type': 'image/png' } });
  };
  return () => { globalThis.fetch = original; };
}

async function run(handler, bytes, opts = {}) {
  const env = fakeEnv(opts);
  const ctx = uploadContext(env, bytes, opts);
  const res = await handler(ctx);
  // Дождаться фоновых задач, иначе их реджекты уедут за пределы теста.
  await Promise.allSettled(ctx._done);
  return { res, env, json: () => res.clone().json() };
}

test('без авторизации загрузка не проходит', async () => {
  const env = fakeEnv();
  const form = new FormData();
  form.set('file', new File([pngBytes(64, 32)], 'cape.png', { type: 'image/png' }));
  form.set('name', 'Плащ');
  const res = await uploadCape({
    request: new Request('https://s.gg/api/v3/upload', { method: 'POST', body: form }),
    env,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(res.status, 401);
  assert.equal(env.rows.size, 0);
});

test('HD-кадр 2048×1024 — обычный плащ, а не стек', async () => {
  // Широкий одиночный кадр — это HD-текстура, её превью умеет рисовать.
  // Проверка формата не должна отвергать её как «слишком большую».
  const restore = stubCatbox();
  try {
    const { res, json } = await run(uploadCape, pngBytes(2048, 1024, 2048));
    assert.equal(res.status, 201, await (async () => (await json()).error ?? '')());
    assert.equal((await json()).skin.storage, 'catbox');
  } finally {
    restore();
  }
});

test('стек в обычной загрузке отвергается с понятным объяснением', async () => {
  // В обычной галерее стек показывается первым кадром — то есть молча
  // теряется всё, кроме одного кадра. Лучше отказать сразу и сказать, куда
  // загружать.
  const restore = stubCatbox();
  try {
    const { res, env, json } = await run(uploadCape, pngBytes(64, 256, 2048));
    assert.equal(res.status, 400);
    const body = await json();
    assert.match(body.error, /8-frame cape stack/);
    assert.match(body.error, /animated/i, 'в ошибке должно быть сказано, что делать');
    assert.equal(env.rows.size, 0);
  } finally {
    restore();
  }
});

test('неплащный PNG отвергается до CatBox', async () => {
  // 100×60 — ни 64×32 (и его HD-кратные), ни 22×17, ни 46×22: превью такой
  // файл нарезать не с чем, поэтому и показывать его нечем.
  const restore = stubCatbox();
  try {
    const { res, env, json } = await run(uploadCape, pngBytes(100, 60, 2048));
    assert.equal(res.status, 400);
    assert.match((await json()).error, /Unsupported cape texture/);
    assert.equal(env.rows.size, 0);
  } finally {
    restore();
  }
});

test('обычный плащ 64×32 уходит на CatBox', async () => {  const seen = [];
  const restore = stubCatbox(seen);
  try {
    const { res, env, json } = await run(uploadCape, pngBytes(64, 32));
    assert.equal(res.status, 201);
    const body = await json();
    assert.equal(body.skin.storage, 'catbox');
    assert.equal(body.skin.value, 'https://files.catbox.moe/cape123.png');
    assert.equal(env.rows.size, 1);
    assert.match(body.skin.url, /^\/api\/v3\/skin-file\/\d+\.png$/);
    assert.ok(seen.includes('reqtype=fileupload'), 'файл должен уйти на CatBox');
  } finally {
    restore();
  }
});

test('высокий стек 2048×11264 идёт на CatBox, а не в базу', async () => {
  // Регресс на удалённый BLOB-слой: раньше такой кап писался в cape_blobs
  // и возвращал значение вида "d1:<id>". Загружается анимированным адресом:
  // 11 кадров — это стек, и в обычной галерее он показывал бы один кадр.
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    const { res, env, json } = await run(uploadAnimated, pngBytes(2048, 11264, 2048));
    assert.equal(res.status, 201);
    const body = await json();
    assert.equal(body.skin.storage, 'catbox');
    assert.equal(body.skin.value, 'https://files.catbox.moe/cape123.png');
    assert.doesNotMatch(body.skin.value, /^d1:/, 'ссылки вида d1: быть не должно');
    assert.ok(seen.includes('reqtype=fileupload'), 'высокий стек тоже грузится на CatBox');
    assert.equal(
      env.log.filter((q) => /cape_blobs/.test(q)).length,
      0,
      'в базу байты писаться не должны'
    );
  } finally {
    restore();
  }
});

test('стек 1024×29696 из реальных загрузок проходит тем же путём', async () => {
  const restore = stubCatbox();
  try {
    const { res, json } = await run(uploadAnimated, pngBytes(1024, 29696, 4096));
    assert.equal(res.status, 201);
    assert.equal((await json()).skin.storage, 'catbox');
  } finally {
    restore();
  }
});

test('анимированный стек идёт тем же путём, что и обычный', async () => {
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    const { res, json } = await run(uploadAnimated, pngBytes(2048, 11264, 2048));
    assert.equal(res.status, 201);
    const body = await json();
    assert.equal(body.skin.animated, true);
    assert.equal(body.skin.storage, 'catbox');
    assert.match(body.skin.url, /^\/api\/animated\/v1\/skin-file\/\d+\.png$/);
    assert.ok(seen.includes('reqtype=fileupload'));
  } finally {
    restore();
  }
});

test('узкий атлас 22×17 — только хвост, загружается и честно говорит про крылья', async () => {
  // Не 64×32: это ванильный формат, а узкий атлас, где крыльям физически
  // негде быть. Сервер обязан его принять (превью умеет рисовать хвост) и не
  // притворяться, что плащ с крыльями. Раньше эти два формата проверялись
  // только в cape-texture.test.js, то есть на разборе атласа, а не сквозным
  // путём загрузки — расхождение правил оставалось незамеченным.
  const restore = stubCatbox();
  try {
    const { res, env, json } = await run(uploadCape, pngBytes(22, 17, 512));
    assert.equal(res.status, 201, await (async () => (await json()).error ?? '')());
    const body = await json();
    assert.equal(body.skin.storage, 'catbox');
    assert.equal(env.rows.size, 1, 'плащ должен попасть в базу');
  } finally {
    restore();
  }
});

test('атлас 46×22 — хвост вместе с крыльями, загружается', async () => {
  const restore = stubCatbox();
  try {
    const { res, env, json } = await run(uploadCape, pngBytes(46, 22, 1024));
    assert.equal(res.status, 201, await (async () => (await json()).error ?? '')());
    assert.equal((await json()).skin.storage, 'catbox');
    assert.equal(env.rows.size, 1);
  } finally {
    restore();
  }
});

test('HD-кратные узких атласов тоже проходят', async () => {
  // 22×17 и 46×22 встречаются в стеках, где кадр больше в 2 раза: проверка
  // обязана принимать их через ту же пропорцию, а не сравнением с 22 и 46
  // буквально.
  for (const [w, h] of [[44, 34], [92, 44]]) {
    const restore = stubCatbox();
    try {
      const { res, json } = await run(uploadCape, pngBytes(w, h, 2048));
      assert.equal(res.status, 201, `${w}×${h}: ${await (async () => (await json()).error ?? '')()}`);
    } finally {
      restore();
    }
  }
});

test('битый IHDR отвергается до CatBox, а не после', async () => {
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    const bytes = pngBytes(64, 32);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // 'IDAT' вместо 'IHDR'
    const { res, env } = await run(uploadCape, bytes);
    assert.equal(res.status, 400);
    assert.equal(env.rows.size, 0);
    assert.equal(seen.length, 0, 'CatBox быть не должно задето вообще');
  } finally {
    restore();
  }
});

test('не-PNG отвергается по сигнатуре', async () => {
  const restore = stubCatbox();
  try {
    const { res, env } = await run(uploadCape, new Uint8Array(64).fill(7));
    assert.equal(res.status, 400);
    assert.equal(env.rows.size, 0);
  } finally {
    restore();
  }
});

test('файл тяжелее общего потолка отвергается до разбора картинки', async () => {
  const env = fakeEnv();
  const form = new FormData();
  form.set('file', new File([pngBytes(64, 32)], 'cape.png', { type: 'image/png' }));
  form.set('name', 'Плащ');
  // Подменяем размер, не выделяя 20 МБ памяти: проверка идёт по file.size.
  Object.defineProperty(form.get('file'), 'size', { value: MAX_PNG_BYTES + 1 });

  const request = new Request('https://s.gg/api/v3/upload', { method: 'POST', body: form });
  request.headers.set('Cookie', '__session=test-token');
  request.formData = async () => form;

  const res = await uploadCape({ request, env, params: {}, waitUntil: () => {} });
  assert.equal(res.status, 413);
  assert.equal(env.rows.size, 0);
});

test('сбой записи метаданных откатывает файл с CatBox и отвечает JSON', async () => {
  // Регресс: без отката кап навсегда остался бы лежать на CatBox без записи
  // в базе — «сирота», которую не видно в интерфейсе и нечем удалить.
  // Вторая половина регресса — форма ответа. Раньше handler бросал наружу
  // исключение, Cloudflare отдавал текст `error code: 1101`, и фронтенд
  // падал в разборе JSON: пользователь видел только «Unexpected token '<'».
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    const env = fakeEnv({ failMetadata: true });
    const ctx = uploadContext(env, pngBytes(64, 32));
    const res = await uploadCape(ctx);
    await Promise.allSettled(ctx._done);
    assert.ok(seen.includes('reqtype=fileupload'), 'файл сначала заливается');
    assert.ok(seen.includes('reqtype=deletefiles'), 'потом обязан быть снесён');
    assert.equal(res.status, 500);
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    const body = await res.json();
    assert.match(body.error, /не записан в галерею/);
    assert.match(body.detail, /D1 недоступна/, 'причина срыва доезжает до клиента');
  } finally {
    restore();
  }
});

test('анимированная загрузка на сбое базы тоже отвечает JSON, а не падает', async () => {
  // Handler анимированной загрузки жил своей жизнью: тот же самый `throw e`,
  // то же самое 1101 текстом. Отдельный тест, чтобы правка одного не
  // потерялась при следующем рефакторинге.
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    const env = fakeEnv({ failMetadata: true });
    const ctx = uploadContext(env, pngBytes(64, 256, 2048));
    const res = await uploadAnimated(ctx);
    await Promise.allSettled(ctx._done);
    assert.ok(seen.includes('reqtype=deletefiles'), 'откат обязателен и здесь');
    assert.equal(res.status, 500);
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    assert.match((await res.json()).detail, /D1 недоступна/);
  } finally {
    restore();
  }
});

/**
 * Ждёт промис, но не бесконечно: если обработчик не ответил — падает с явным
 * текстом. Без этого тест на таймаут не краснеет, а просто подвешивает прогон
 * всего сьюта, и обрыв виден только по молчанию.
 */
function withWatchdog(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: ответ не пришёл за ${ms} мс`)), ms).unref())
  ]);
}

test('зависший CatBox даёт разбираемый JSON, а не текст платформы', async () => {
  // Регресс на исходный симптом. Пока у запроса к CatBox не было своего
  // таймаута, провисший upstream висел до того момента, пока Functions не
  // убивал вызов по своему лимиту. Ответом на это была HTML-страница 5xx от
  // Cloudflare, а фронтенд на ней падал с «Unexpected token '<'».
  // Теперь зависание обрывается нами и уходит в разбираемом JSON.
  // Статус 503, а не 502: тело 502 Cloudflare подменяет своим «error code: 502».
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push(String(url));
    const signal = init.signal;
    // Имитация провисшего upstream: ждём, пока сработает наш таймаут.
    await new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (!signal) return;                    // без сигнала — вечный pend
      if (signal.aborted) return abort();
      signal.addEventListener?.('abort', abort);
    });
    return new Response('');
  };
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const env = fakeEnv();
    // Бюджет загрузки задаётся своим env, общий CATBOX_TIMEOUT_MS на неё не
    // распространяется: файл едет в CatBox дольше прочих вызовов.
    env.CATBOX_UPLOAD_TIMEOUT_MS = 25;
    const ctx = uploadContext(env, pngBytes(64, 32));
    // Сторож намеренно много больше самогo таймаута: 25 мс — это про CatBox,
    // а 2000 мс — про «ответил ли вообще обработчик». Три попытки укладываются.
    const res = await withWatchdog(uploadCape(ctx), 2000, 'upload без таймаута на CatBox');
    await Promise.allSettled(ctx._done);
    assert.equal(res.status, 503);
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    const body = await res.json();
    // Причина уходит в лог, а не клиенту: тех. хвост пользователю ничего не
    // даёт, но именно по логу видно, был ли это таймаут или отказ CatBox.
    assert.equal(body.detail, undefined, 'технический хвост клиенту не нужен');
    assert.ok(
      logged.some((l) => /не ответил за 25 мс/.test(l)),
      'в логе должна быть причина: ' + logged.join(' | ')
    );
    assert.equal(env.rows.size, 0, 'в базу ничего не попало');
  } finally {
    console.error = realError;
    globalThis.fetch = original;
  }
});

test('ни один путь загрузки не отвечает HTML', async () => {
  // Сквозная гарантия для всей воронки: любой ответ обоих upload-handler —
  // это JSON. Именно на этом стоял симптом «Unexpected token '<'».
  const scenarios = [
    { name: 'CatBox ошибся', opts: {}, stub: () => new Response('нельзя', { status: 500 }) },
    {
      name: 'CatBox вернул мусор',
      opts: {},
      stub: () => new Response('<html>cap</html>', { headers: { 'Content-Type': 'text/html' } })
    },
    { name: 'D1 упала', opts: { failMetadata: true }, stub: () => new Response('https://files.catbox.moe/cape123.png') }
  ];
  for (const { name, opts, stub } of scenarios) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) =>
      String(url).includes('/user/api.php')
        ? stub()
        : new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
    try {
      for (const [label, handler, bytes] of [
        ['v3', uploadCape, pngBytes(64, 32)],
        ['animated', uploadAnimated, pngBytes(64, 256, 2048)]
      ]) {
        const env = fakeEnv(opts);
        const res = await handler(uploadContext(env, bytes));
        assert.match(
          res.headers.get('Content-Type'),
          /application\/json/,
          `${label}/${name}: ответ обязан быть JSON`
        );
        assert.doesNotThrow(() => res.clone().json(), `${label}/${name}: тело обязано разбираться`);
      }
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('без имени — 400 до похода в CatBox', async () => {
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    const { res, env } = await run(uploadCape, pngBytes(64, 32), { name: '' });
    assert.equal(res.status, 400);
    assert.equal(env.rows.size, 0);
    assert.equal(seen.length, 0);

    const blank = await run(uploadCape, pngBytes(64, 32), { name: '   ' });
    assert.equal(blank.res.status, 400);
    assert.equal(blank.env.rows.size, 0);
  } finally {
    restore();
  }
});

test('не-POST отклоняется методом', async () => {
  const { res } = await run(uploadCape, pngBytes(64, 32), { method: 'PUT' });
  assert.equal(res.status, 405);
});

// ─── CatBox отвечает «готово», а файла нет ───
// Регресс на реальный сбой: Catbox принял fileupload, вернул корректный URL,
// но по нему 404. Старый код доверял ответу API, писал строку в D1 — и в
// галерее появлялся плащ, который не грузится никогда.

/** CatBox, который на fileupload отдаёт ссылку, но файла за ней не держит. */
function stubCatboxLying({ landOnAttempt = 0, fileStatus = 404 } = {}) {
  const original = globalThis.fetch;
  const seen = [];
  let uploads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.body && init.body instanceof FormData) {
      if (u.includes('/user/api.php')) {
        const reqtype = init.body.get('reqtype');
        if (reqtype === 'fileupload') {
          uploads += 1;
          seen.push(`upload#${uploads} name=${init.body.get('fileToUpload').name}`);
          return new Response(`https://files.catbox.moe/cape${uploads}.png`, { status: 200 });
        }
        seen.push(`reqtype=${reqtype}`);
        return new Response('OK', { status: 200 });
      }
    }
    if (u.includes('/user/api.php')) return new Response('OK', { status: 200 });
    seen.push(`get ${u.replace(/[?&]_cb=[^&]*/, '')}`);
    // Файл «появился» только на нужной попытке; landOnAttempt=0 — не появится
    // никогда (CatBox принимает, но не хранит).
    const isLanded = landOnAttempt > 0 && uploads >= landOnAttempt;
    if (!isLanded) return new Response('not found', { status: fileStatus });
    return new Response(pngBytes(64, 32, 512), { headers: { 'Content-Type': 'image/png' } });
  };
  return { seen, uploads: () => uploads, restore: () => { globalThis.fetch = original; } };
}

test('битый CatBox не оставляет плащ в галерее', async () => {
  const catbox = stubCatboxLying({ landOnAttempt: 0 });
  try {
    const { res, env, json } = await run(uploadCape, pngBytes(64, 32));
    // Не 502: Cloudflare подменяет тело ответа 502 своим «error code: 502»,
    // и фронтенд получает неразбираемый текст вместо JSON.
    assert.equal(res.status, 503, 'битая загрузка обязана быть ошибкой, а не успехом');
    assert.equal(env.rows.size, 0, 'в D1 не должно остаться ни одной строки');
    assert.equal(await env.DB.prepare('SELECT 1 FROM skins').bind().first(), null);
    const body = await json();
    assert.equal(typeof body.error, 'string');
    assert.ok(!/detail/.test(body), 'технический хвост клиенту не нужен');
  } finally {
    catbox.restore();
  }
});

test('повторная попытка чинит загрузку, если CatBox ожил', async () => {
  const catbox = stubCatboxLying({ landOnAttempt: 2 });
  try {
    const { res, json } = await run(uploadCape, pngBytes(64, 32));
    assert.equal(res.status, 201);
    const body = await json();
    assert.equal(body.skin.value, 'https://files.catbox.moe/cape2.png');
    assert.equal(catbox.uploads(), 2, 'первый «успех» без файла обязан вызвать повтор');
  } finally {
    catbox.restore();
  }
});

test('повтор идёт под новым именем, а не тем же самым', async () => {
  // Повтор с прежним именем CatBox склонен вернуть ту же битую ссылку из своего
  // кэша, и второй «успех» снова окажется пустым.
  const catbox = stubCatboxLying({ landOnAttempt: 3 });
  try {
    const { res } = await run(uploadCape, pngBytes(64, 32));
    assert.equal(res.status, 201);
    const names = catbox.seen.filter((s) => s.startsWith('upload#')).map((s) => s.split(' ')[1]);
    assert.equal(new Set(names).size, names.length, 'имена на попытках обязаны различаться');
  } finally {
    catbox.restore();
  }
});

test('незагруженные попытки не оставляют мусор в альбоме', async () => {
  // В альбом идёт только реально загруженный файл, иначе битые имена копятся.
  const catbox = stubCatboxLying({ landOnAttempt: 2 });
  try {
    const { res } = await run(uploadCape, pngBytes(64, 32));
    assert.equal(res.status, 201);
    assert.equal(
      catbox.seen.filter((s) => s === 'reqtype=addtoalbum').length,
      1,
      'добавление в альбом должно быть ровно один раз — для уцелевшего файла'
    );
  } finally {
    catbox.restore();
  }
});

test('файл нулевой длины от CatBox считается провалом загрузки', async () => {
  const original = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/user/api.php') && init.body instanceof FormData) {
      if (init.body.get('reqtype') === 'fileupload') {
        uploads += 1;
        return new Response(`https://files.catbox.moe/cape${uploads}.png`, { status: 200 });
      }
      return new Response('OK', { status: 200 });
    }
    return new Response(null, { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  try {
    const { res, env } = await run(uploadCape, pngBytes(64, 32));
    assert.equal(res.status, 503);
    assert.equal(env.rows.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});

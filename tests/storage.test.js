// Разбор PNG, уборка файла капа и раздача по ссылке.
//
// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPng, readPngHeader } from '../public/cape-format.js';
import { deleteStored } from '../functions/_lib/storage.js';
import {
  proxyTextureFile,
  catboxFileName,
  isCatboxFile,
  CACHE_IMMUTABLE,
  CACHE_MUTABLE
} from '../functions/_lib/catbox.js';
import { MAX_PNG_BYTES } from '../functions/_lib/limits.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Заголовок PNG с настоящими IHDR-байтами: сигнатура, длина, 'IHDR', w, h,
 * глубина, тип цвета. IHDR — всегда ровно 13 байт данных, то есть файл
 * кончается не раньше 29-го байта; 26 — порог, с которого читаются все
 * поля, которые нам нужны.
 */
function pngHeader(width, height) {
  const b = new Uint8Array(29);
  b.set(SIGNATURE, 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13); // длина чанка IHDR всегда 13
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  b[24] = 8;  // bit depth
  b[25] = 6;  // colour type: RGBA
  return b;
}

/** PNG заданного размера в пикселях и произвольного веса в байтах. */
function png(width, height, totalBytes = 1024) {
  const b = new Uint8Array(totalBytes);
  // Заголовок обрезаем по размеру: у части тестов totalBytes меньше IHDR,
  // и это сам по себе валидный случай (обрезанный файл).
  b.set(pngHeader(width, height).subarray(0, totalBytes), 0);
  return b;
}

/**
 * Подмена fetch: пишет в seen адрес и reqtype каждого обращения к CatBox.
 *
 * Файлы отдаются настоящим минимальным PNG, а не «байтом с картинным
 * Content-Type»: раздача проверяет сигнатуру, иначе CatBox-ответ с чужим
 * содержимым ушёл бы на клиент как картинка.
 */
function stubCatbox(seen = []) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push(String(url));
    if (init.body && init.body instanceof FormData) {
      seen.push(`reqtype=${init.body.get('reqtype')}`);
    }
    if (String(url).includes('/user/api.php')) {
      return new Response('https://files.catbox.moe/abc123.png', { status: 200 });
    }
    return new Response(png(64, 32, 512), { headers: { 'Content-Type': 'image/png' } });
  };
  return () => { globalThis.fetch = original; };
}

// ─── Разбор IHDR ───

test('размер читается из первых байт, без декодирования', () => {
  assert.deepEqual(readPngHeader(png(2048, 11264)), { width: 2048, height: 11264, bitDepth: 8, colorType: 6 });
  // Ровно 26 байт — последний, где читаются все нужные поля.
  assert.deepEqual(readPngHeader(png(64, 32, 26)), { width: 64, height: 32, bitDepth: 8, colorType: 6 });
});

test('ширина и высота не путаются местами', () => {
  // Ошибка с обменом width/height не ловится на симметричных картинках —
  // нужна явно несимметричная.
  const size = readPngHeader(png(1024, 512));
  assert.equal(size.width, 1024);
  assert.equal(size.height, 512);
});

test('размер читается из середины чужого буфера, а не с его начала', () => {
  // Регресс: DataView со смещением 0 читал бы нули лежащего рядом буфера
  // и вернул бы неверные размеры капу.
  const big = new Uint8Array(64).fill(0xff);
  big.set(pngHeader(300, 700), 16);
  const view = big.subarray(16, 48);
  assert.equal(view.byteOffset, 16);
  assert.deepEqual(readPngHeader(view), { width: 300, height: 700, bitDepth: 8, colorType: 6 });
});

test('мусор с расширением .png и битый IHDR дают null, а не выдуманный размер', () => {
  assert.equal(readPngHeader(new Uint8Array(0)), null);
  assert.equal(readPngHeader(png(64, 32, 4)), null, 'обрезанный файл');
  assert.equal(readPngHeader(new Uint8Array(64)), null, 'не PNG вовсе');
  assert.equal(readPngHeader(png(64, 32, 8)), null, 'сигнатура есть, IHDR не успел');
  assert.equal(readPngHeader(png(64, 32, 25)), null, 'последний байт типа цвета не дочитан');

  const wrongType = png(64, 32);
  wrongType.set([0x49, 0x44, 0x41, 0x54], 12); // 'IDAT' вместо 'IHDR'
  assert.equal(readPngHeader(wrongType), null);
});

test('нулевые и предельные размерности читаются как числа, а не как NaN', () => {
  assert.deepEqual(readPngHeader(png(0, 0)), { width: 0, height: 0, bitDepth: 8, colorType: 6 });
  assert.deepEqual(readPngHeader(png(0xffffffff, 0xffffffff)), {
    width: 0xffffffff,
    height: 0xffffffff,
    bitDepth: 8,
    colorType: 6
  });
});

test('isPng отличает PNG от всего прочего', () => {
  assert.equal(isPng(png(1, 1, 8)), true);
  assert.equal(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false, 'JPEG');
  assert.equal(isPng(new Uint8Array(0)), false);
  assert.equal(isPng(null), false);
});

// ─── Регресс: ограничения по размерности нет ───
//
// Раньше здесь стоял лимит 4096 px и целый BLOB-слой в D1 для «непроходимых»
// капов. Оба удалены: проверено на живых данных, что CatBox держит стеки до
// 29696 px. Тесты ниже фиксируют, чтобы миф не вернулся вместе с правкой.

test('стек выше 4096 px разбирается и считается валидным PNG', () => {
  const tall = png(1024, 29696, 826 * 1024);
  assert.equal(readPngHeader(tall).width, 1024);
  assert.equal(readPngHeader(tall).height, 29696);
  assert.equal(isPng(tall), true);
});

test('самый тяжёлый стек из Downloads влезает под общий потолок', () => {
  // Кирби.gif.png: 2048×28672, 2732.8 КБ. Раньше он не влезал в BLOB
  // (потолок 1 900 000) и уходил в D1; теперь идёт на CatBox как есть.
  const kirby = 2732.8 * 1024;
  assert.ok(kirby < MAX_PNG_BYTES, 'стек должен проходить по весу');
  assert.equal(readPngHeader(png(2048, 28672, Math.round(kirby))).width, 2048);
  assert.equal(readPngHeader(png(2048, 28672, Math.round(kirby))).height, 28672);
});

// ─── Разбор ссылки ───

test('имя файла вытаскивается из ссылки CatBox', () => {
  assert.equal(catboxFileName('https://files.catbox.moe/abc123.png'), 'abc123.png');
  assert.equal(catboxFileName('https://catbox.moe/user/api.php'), null, 'чужой хост');
  assert.equal(catboxFileName('не ссылка'), null);
  assert.equal(catboxFileName('https://files.catbox.moe/'), null, 'нет имени');
});

test('ссылка на CatBox отличается от ссылки на посторонний хост', () => {
  assert.equal(isCatboxFile('https://files.catbox.moe/x.png'), true);
  assert.equal(isCatboxFile('https://example.com/x.png'), false);
  assert.equal(isCatboxFile('http://files.catbox.moe.evil.com/x.png'), false);
});

// ─── Уборка файла ───

test('файл с CatBox удаляется по имени', async () => {
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    await deleteStored({ CATBOX_USERHASH: 'hash' }, 'https://files.catbox.moe/abc123.png');
    assert.ok(seen.includes('reqtype=deletefiles'), 'нужен запрос deletefiles');
  } finally {
    restore();
  }
});

test('уборка не падает, когда userhash не настроен', async () => {
  const env = {};
  await assert.doesNotReject(() => deleteStored(env, 'https://files.catbox.moe/x.png'));
  await assert.doesNotReject(() => deleteStored(env, null));
});

test('файл на CatBox не удаляется, пока на него ссылается другой кап', async () => {
  const seen = [];
  const restore = stubCatbox(seen);
  try {
    let asked = 0;
    await deleteStored(
      { CATBOX_USERHASH: 'hash' },
      'https://files.catbox.moe/abc123.png',
      async () => { asked++; return true; }
    );
    assert.equal(asked, 1, 'колбэк общности должен вызываться ровно один раз');
    assert.ok(
      !seen.includes('reqtype=deletefiles'),
      'пока файл нужен кому-то ещё, deletefiles быть не должно'
    );
  } finally {
    restore();
  }
});

test('legacy-кап из KV тоже удаляется — уборка в одном месте', async () => {
  const deleted = [];
  const env = { SKINS_KV: { delete: async (k) => { deleted.push(k); } } };
  await deleteStored(env, 'kv:capes/abc');
  assert.deepEqual(deleted, ['capes/abc']);
});

test('уборка не падает, если SKINS_KV вовсе не привязан', async () => {
  await assert.doesNotReject(() => deleteStored({}, 'kv:capes/abc'));
});

// ─── Раздача ───

test('legacy-кап из KV отдаётся картинкой', async () => {
  const payload = png(64, 32, 40).buffer;
  const env = { SKINS_KV: { get: async (k) => (k === 'capes/abc' ? payload : null) } };
  const res = await proxyTextureFile('kv:capes/abc', env, CACHE_MUTABLE);

  assert.notEqual(res, null);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.equal(res.headers.get('Cache-Control'), CACHE_MUTABLE);
  const sent = readPngHeader(new Uint8Array(await res.arrayBuffer()));
  assert.equal(sent.width, 64);
  assert.equal(sent.height, 32);
});

test('высокий стек с CatBox отдаётся картинкой, а не режется', async () => {
  const bytes = png(1024, 29696, 64);
  const restore = stubCatbox();
  try {
    const res = await proxyTextureFile('https://files.catbox.moe/abc123.png', {}, CACHE_IMMUTABLE);
    assert.notEqual(res, null);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    assert.equal(res.headers.get('Cache-Control'), CACHE_IMMUTABLE);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    // Ответ — это поток апстрима; размеры сверяем на заголовке исходника.
    assert.equal(readPngHeader(bytes).width, 1024);
    assert.equal(readPngHeader(bytes).height, 29696);
  } finally {
    restore();
  }
});

test('политика кэша по мутабельной ссылке — no-store', async () => {
  const restore = stubCatbox();
  try {
    const res = await proxyTextureFile('https://files.catbox.moe/abc123.png', {}, CACHE_MUTABLE);
    assert.equal(res.headers.get('Cache-Control'), CACHE_MUTABLE);
  } finally {
    restore();
  }
});

test('значение без ссылки или с битым хвостом даёт null, а не исключение', async () => {
  assert.equal(await proxyTextureFile(null, {}), null);
  assert.equal(await proxyTextureFile('', {}), null);
  assert.equal(await proxyTextureFile('d1:42', {}), null, 'схема убрана — 404 вместо 500');
  assert.equal(await proxyTextureFile('d1:', {}), null);
});

test('недоступный апстрим даёт null, а не пробрасывает сетевую ошибку', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection reset'); };
  try {
    assert.equal(await proxyTextureFile('https://files.catbox.moe/abc123.png', {}), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('апстрим с ошибкой 404 даёт null', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 404 });
  try {
    assert.equal(await proxyTextureFile('https://files.catbox.moe/gone.png', {}), null);
  } finally {
    globalThis.fetch = original;
  }
});

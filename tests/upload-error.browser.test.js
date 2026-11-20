// Сквозной регресс на исходный симптом: `Unexpected token '<', "<!DOCTYPE "... is
// not valid JSON` при загрузке плаща.
//
// Поднимаем настоящий index.html с настоящим app.js и подсовываем через
// /api/v3/upload HTML-заглушку — ровно то, что отдаёт Cloudflare, когда по
// маршруту нет Function. Смотрим, что написано пользователю в тосте.
//
// Юнит-тесты api-response.js проверяют сам разбор, но не проверяют, что к нему
// действительно пришёл фронтенд: откат app.js или animated.js на голый
// res.json() прошёл бы их молча. Этот тест ловит именно такой откат.
//
// Скипается, если нет Chromium (см. helpers/browser.js).
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { skipReason, startHarness, PUBLIC } from './helpers/browser.js';

const skip = await skipReason();

const HTML_FALLBACK = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>SkinBase</title></head>
<body><div id="root"></div></body></html>`;

// Ответы, которые фронтенд получает при загрузке страницы. Галерея пустая —
// тогда не создаются карточки превью и skinview3d не нужен. Обе страницы
// (обычная и анимированная) живут на одном наборе общих маршрутов.
const BOOT = {
  '/api/v3/limits': { maxPngBytes: 20971520, maxPngMb: 20 },
  '/api/v3/me': { user: { id: 1, username: 'GG' } },
  '/api/v3/skins': { skins: [] },
  '/api/v3/equip': { equipped: { cape: null } },
  '/api/v3/backup': {},
  '/api/v3/tokens': { tokens: [] },
  '/api/animated/v1/skins': { skins: [] },
  '/api/animated/v1/equip': { equipped: null }
};

// Ответ загрузки меняется из теста; handler сервера его читает.
let uploadReply = null;
const seen = [];

let h;

before(async () => {
  if (skip) return;
  h = await startHarness({
    path: '/',
    routes(req, res) {
      const path = req.url.split('?')[0];

      if (req.method === 'POST' && (path === '/api/v3/upload' || path === '/api/animated/v1/upload')) {
        seen.push(path);
        const r = uploadReply;
        if (!r) { res.writeHead(500); res.end('тест не задал ответ'); return true; }
        res.writeHead(r.status, { 'content-type': r.contentType });
        res.end(r.body);
        return true;
      }

      if (BOOT[path] !== undefined && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(BOOT[path]));
        return true;
      }

      if (path === '/' || path === '/index.html' || path === '/animated.html') {
        const file = path === '/animated.html' ? 'animated.html' : 'index.html';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(PUBLIC, file)));
        return true;
      }

      // Модули фронтенда — как есть: тестируется боевой код, а не копия.
      if (/\.(js|css)$/.test(path)) {
        try {
          res.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' });
          res.end(readFileSync(join(PUBLIC, path.slice(1))));
          return true;
        } catch {}
      }
      return false;
    }
  });
  await h.goto();
  // Ждём монтирования app.js: обработчик submit появляется при импорте модуля.
  await h.page.waitForFunction(
    () => !!document.querySelector('#skin-form') && !!document.querySelector('.nav-link[data-view="add"]')
  );
});

after(async () => { if (h) await h.close(); });

/** Открывает форму добавления, кладёт файл, вводит имя и отправляет. */
async function submitUpload(page, name) {
  // Тост живёт 3 секунды, поэтому перед отправкой контейнер очищается: иначе
  // waitForSelector мгновенно нашёл бы тост из предыдущего теста.
  await page.evaluate(() => { document.querySelector('#toast-container').innerHTML = ''; });
  await page.click('.nav-link[data-view="add"]');
  await page.setInputFiles('#skin-file-input', {
    name: 'cape.png', mimeType: 'image/png', buffer: CAPE_PNG
  });
  await page.fill('#skin-name', name);
  await page.click('#skin-submit');
  await page.waitForSelector('#toast-container .toast', { timeout: 5000 });
  return (await page.textContent('#toast-container .toast')).trim();
}

/** Прямоугольный PNG 64×32 — размер, который принимает и клиент, и сервер. */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    // CRC для этих заглушек не разбирается браузером при загрузке: файл всё
    // равно уходит на сервер как есть, а разбор идёт только по IHDR и tEXt.
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const CAPE_PNG = makePng(64, 32);

test('HTML-заглушка вместо JSON больше не превращается в ошибку разбора', async t => {
  if (skip) return t.skip(skip);
  seen.length = 0;
  uploadReply = { status: 200, contentType: 'text/html; charset=UTF-8', body: HTML_FALLBACK };

  const message = await submitUpload(h.page, 'Плащ');

  assert.ok(seen.includes('/api/v3/upload'), 'форма обязана дойти до загрузки');
  assert.doesNotMatch(message, /Unexpected token/, `пользователь снова видит шум браузера: ${message}`);
  assert.doesNotMatch(message, /JSON\.parse/, `в сообщении остался разбор: ${message}`);
  assert.match(message, /не JSON/, 'сообщение должно называть суть: ответ не JSON');
  assert.match(message, /200/, 'в сообщении должен быть код ответа');
  assert.match(message, /\/api\/v3\/upload/, 'в сообщении должен быть адрес запроса');
});

test('текстовая ошибка 1101 вместо JSON не теряется', async t => {
  if (skip) return t.skip(skip);
  uploadReply = { status: 500, contentType: 'text/plain', body: 'error code: 1101' };

  const message = await submitUpload(h.page, 'Плащ 1101');

  assert.doesNotMatch(message, /Unexpected token/, `пользователь снова видит шум браузера: ${message}`);
  assert.match(message, /не JSON/);
  assert.match(message, /1101/);
});

test('ошибка приложения доезжает в тост как есть', async t => {
  if (skip) return t.skip(skip);
  uploadReply = {
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ error: 'Unsupported cape texture: frame 100x60' })
  };

  const message = await submitUpload(h.page, 'Плащ 400');

  assert.equal(message, 'Unsupported cape texture: frame 100x60');
});

test('успешная загрузка по-прежнему радует, а не ругается', async t => {
  // Разбор ответа переписан целиком; если бы он сломал обычный путь, это
  // было бы видно только здесь.
  if (skip) return t.skip(skip);
  uploadReply = {
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ skin: { id: 7, name: 'Плащ 201', storage: 'catbox' } })
  };

  const message = await submitUpload(h.page, 'Плащ 201');

  assert.equal(message, 'Плащ добавлен');
});

// ─── Анимированная страница ───
//
// Здесь разбор ответа раньше глушился через `.catch(() => ({}))`: HTML или
// текст превращались в пустой объект, и ошибка всплывала позже как «Что-то
// пошло не так» — то есть тоже без причины, но уже безошибочно незаметно.

test('анимированная страница открывается и её форма на месте', async t => {
  if (skip) return t.skip(skip);
  await h.page.goto(h.base + '/animated.html');
  await h.page.waitForFunction(() => !!document.querySelector('#skin-form'));
});

test('анимированная загрузка: HTML-заглушка называет себя HTML-страницей', async t => {
  if (skip) return t.skip(skip);
  await h.page.goto(h.base + '/animated.html');
  await h.page.waitForFunction(
    () => !!document.querySelector('#skin-form') && !!document.querySelector('.nav-link[data-view="add"]')
  );
  seen.length = 0;
  uploadReply = { status: 200, contentType: 'text/html; charset=UTF-8', body: HTML_FALLBACK };

  const message = await submitUpload(h.page, 'Стек');

  assert.ok(seen.includes('/api/animated/v1/upload'), 'форма обязана дойти до загрузки');
  assert.doesNotMatch(message, /Unexpected token/, `пользователь снова видит шум браузера: ${message}`);
  assert.doesNotMatch(message, /JSON\.parse/, `в сообщении остался разбор: ${message}`);
  assert.match(message, /не JSON/);
  assert.match(message, /HTML-страниц/);
  // Ключевое отличие от прежнего поведения: причина больше не теряется.
  assert.doesNotMatch(message, /Что-то пошло не так/, 'причина не должна теряться за общим текстом');
});

test('анимированная загрузка: текст 1101 не превращается в пустой объект', async t => {
  if (skip) return t.skip(skip);
  uploadReply = { status: 500, contentType: 'text/plain', body: 'error code: 1101' };

  const message = await submitUpload(h.page, 'Стек 1101');

  assert.match(message, /1101/, 'причина обязана дойти до пользователя');
});

test('анимированная загрузка по-прежнему успешна', async t => {
  if (skip) return t.skip(skip);
  uploadReply = {
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ skin: { id: 9, name: 'Стек 201', animated: true } })
  };

  const message = await submitUpload(h.page, 'Стек 201');

  assert.equal(message, 'Анимированный плащ добавлен');
});
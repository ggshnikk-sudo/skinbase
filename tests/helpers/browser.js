// Общая обвязка браузерных тестов: поиск Chromium/Playwright, локальный
// сервер с фикстурами и запуск Chromium с программным WebGL.
//
// Playwright намеренно НЕ в package.json: без браузера тесты скипаются,
// чтобы `npm test` оставался зелёным на машине без Chromium.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PUBLIC = join(ROOT, 'public');

export const SKINVIEW3D_URL = 'https://cdn.jsdelivr.net/npm/skinview3d@3.4.2/bundles/skinview3d.bundle.min.js';

function loadPlaywright() {
  const require = createRequire(join(ROOT, 'noop.js'));
  for (const id of ['playwright', 'playwright-core', '/mnt/sda_home/gg_tv/node_modules/playwright']) {
    try { return require(id); } catch {}
  }
  return null;
}

// Синхронная: результат читается на верхнем уровне модуля, а промис всегда
// truthy — проверка «нет браузера» не сработала бы никогда.
function findChromium() {
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    try { readFileSync(p); return p; } catch {}
  }
  return null;
}

const playwright = loadPlaywright();
const chromiumPath = findChromium();

// Экспортируются для тестов, которым нужен доступ к самому браузеру, а не к
// готовой странице (например, чтобы самому поднять сервер с фикстурами).
export const chromium = chromiumPath;
export const hasBrowser = Boolean(playwright && chromiumPath);

/** Запускает Chromium с WebGL. Бросает, если браузера нет. */
export async function launchChromium() {
  if (!playwright || !chromiumPath) throw new Error('Chromium недоступен');
  return playwright.chromium.launch({
    executablePath: chromiumPath,
    // Без этих флагов в headless нет WebGL вообще.
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
}

/**
 * Строка-причина скипа или false, если браузер и сеть в порядке.
 *
 * Именно false, а не null: в Node 26 сам факт наличия ключа `skip` в опциях
 * теста помечает его скипнутым, даже если значение falsy. С null тесты
 * молча уезжали в SKIP с exit 0.
 */
export async function skipReason({ needSkinview3d = false } = {}) {
  if (!playwright) return 'нет Playwright — браузерные тесты скипнуты';
  if (!chromiumPath) return 'нет Chromium — браузерные тесты скипнуты';
  if (!needSkinview3d) return false;
  try {
    const res = await fetch(SKINVIEW3D_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    return `skinview3d не скачался (${e.message}) — браузерные тесты скипнуты`;
  }
  return false;
}

export async function fetchSkinview3d() {
  const res = await fetch(SKINVIEW3D_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Поднимает сервер и Chromium и открывает страницу.
 *
 * routes — функция (req, res) => boolean: вернула true, если запрос
 * обслужен. Всё остальное отдаёт 404, чтобы «случайно сработавшая» страница
 * не выглядела как успешный тест.
 */
export async function startHarness({ routes, viewport = { width: 1280, height: 800 }, path = '/' }) {  const server = createServer((req, res) => {
    if (routes(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('нет такого маршрута');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await launchChromium();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  return {
    base,
    page,
    errors,
    async goto(url = path) {
      await page.goto(base + url);
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/** Средний цвет канваса — чтобы отличать хвост от крыльев по пикселям. */
export async function meanColor(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    // Канвас вьюера рисуется WebGL, поэтому снимок идёт через drawImage
    // в 2D-канвас, а не через getImageData самого GL-контекста.
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.drawImage(el, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    return n ? { r: r / n, g: g / n, b: b / n, opaque: n } : { r: 0, g: 0, b: 0, opaque: 0 };
  }, selector);
}

/** Снимок пикселей канваса превью в виде строки — для сравнения «до/после». */
export async function canvasSignature(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d');
    ctx.drawImage(el, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let sig = '';
    for (let i = 0; i < d.length; i += 4) {
      sig += d[i] > 127 ? '1' : '0';
    }
    return sig;
  }, selector);
}

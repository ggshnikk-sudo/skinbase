// Регрессия: превью статичных плащей белело и ломалось ПОСЛЕ прокрутки.
//
// Три причины, все в жизненном цикле вьюера (public/app.js):
//
//   1. dispose() в skinview3d гасит анимацию и GPU-ресурсы, но КАНВАС из
//      контейнера не убирает. Каждый цикл прокрутки подкладывал ещё один холст,
//      .skin-preview с overflow:hidden начинал резать картинку.
//   2. renderer.dispose() не отпускает WebGL-контекст — слот продолжает числиться
//      занятым. Chromium держит 16 ЖИВЫХ контекстов на страницу и при превышении
//      МОЛЧА отбирает самый старый: карточка перестаёт рисовать без всякой ошибки.
//      Замерено в браузере: forceContextLoss() срезает число таких жертв с 44
//      до 12, но потолок 16 не поднимает — отсюда ещё и жёсткий потолок вьюеров.
//   3. renderEquipped() гасил observeCapeCards(), и после любой экипировки
//      превью в библиотеке пропадали навсегда.
//
// Тест гоняет НАСТОЯЩИЙ public/app.js в Chromium, как ESM-модуль — ровно так,
// как его подключает public/index.html. Браузера нет — пропускается.
//
// Что эти тесты действительно ловят (проверено откатом правок в app.js):
//   • баг 1 — dispose(), не убирающий канвас: 3 из 4 тестов падают;
//   • баг 3 — renderEquipped(), гасящий observeCapeCards(): падает тест на
//     наблюдатель («экипировка сняла 9 вьюеров»).
//
// Чего они НЕ ловят, и это надо понимать, а не считать покрытым: баг 2
// (renderer.dispose() без forceContextLoss() не отпускает слот). Замер с
// контролем: 14 циклов прокрутки по 16 карточкам создают ~160 контекстов, и
// мёртвых карточек 0 — с forceContextLoss() и без него одинаково. Причина в
// потолке MAX_CAPE_VIEWERS: живых контекстов никогда не становится больше
// 14, а Chromium отбирает только после 16, поэтому условие отбора не наступает
// и баг замаскирован. Тест на него нужен с поднятым потолком — но тогда падает
// проверка потолка, так что это должен быть отдельный тест с отдельной фикстурой.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { skipReason, fetchSkinview3d, launchChromium, PUBLIC } from './helpers/browser.js';

// Потолок одновременных вьюеров продублирован из app.js намеренно: проверка
// ниже идёт по этому числу, и молчаливая замена константы должна её ронять.
// 14, а не 12: Chromium держит 16 живых WebGL-контекстов, один слот отдан
// превью экипировки, и 14 оставляет запас.
const MAX_CAPE_VIEWERS = 14;

// ─── Минимальный кодировщик PNG, чтобы фикстура не тащила файлов ───
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Настоящий плащ 64×32: хвост заполнен (x<22), крылья пустые — как у капа
// без нарисованных крыльев. С withWings крылья тоже нарисованы (x∈[22,46)),
// чтобы вердикт стал «yes» и тумблер «Плащ/Крылья» появился.
function makeCapePng(withWings = false) {
  const W = 64, H = 32;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const inCape = x < 22;
      // Как в настоящих плащах: крылья занимают правую широкую панель
      // x∈[36,46), левая x∈[24,34) пустая. Если фикстура зальёт обе, тест
      // перестанет ловить ELYTRA_FACE, уехавший в пустую панель.
      const inWing = withWings && x >= 36 && x < 46 && y >= 2 && y < 22;
      raw[o++] = inCape ? 201 : inWing ? 64 : 0;
      raw[o++] = inCape ? 125 : inWing ? 64 : 0;
      raw[o++] = inCape ? 64 : inWing ? 201 : 0;
      raw[o++] = inCape || inWing ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Разметка берётся из НАСТОЯЩЕГО public/index.html. Собранная руками копия
// разъехалась с реальной страницей: app.js дёргает $('#search-input') на верхнем
// уровне, и модуль падал с TypeError до того, как тест что-либо проверял. Такие
// падения приходилось ловить вручную — здесь DOM просто не может устареть.
// Две страницы: с skinview3d и без него. Без библиотеки плоский путь не
// конкурирует с промоушеном — «Крылья» не могут поднять карточку в 3D — и
// области рисуются по-настоящему, без подмены.
function harnessHtml(opts = {}) {
  const with3d = opts.with3d !== false;
  const real = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
  return real
    // skinview3d локально, чтобы тест не ходил в CDN за второй раз.
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/,
      with3d ? '<script src="/skinview3d.js"></script>' : '')
    // Ловим вьюеры: у SkinViewer есть playerObject, и без ссылки на него
    // нельзя проверить, что модель реально переключилась на крылья, а не что
    // на карточке просто появился какой-то холст.
    .replace('<script src="/skinview3d.js"></script>', with3d ? `<script src="/skinview3d.js"></script>
<script>
window.__viewers = [];
(function patch() {
  if (!window.skinview3d) { setTimeout(patch, 5); return; }
  const Original = window.skinview3d.SkinViewer;
  window.skinview3d.SkinViewer = class extends Original {
    constructor(...a) { super(...a); window.__viewers.push(this); }
  };
})();
</script>` : '<script src="/skinview3d.js"></script>')
    // API недоступен — любой запрос к нему должен падать, а не уходить в сеть.
    // Текстуры плащей, наоборот, пропускаем: их разбор loadTexture() — часть
    // проверяемого поведения, и заглушка ломала бы плоский вариант превью.
    .replace('</head>', `<script>
      const realFetch = window.fetch;
      window.fetch = (u, o) => /\\.(png|jpg|jpeg|webp)(\\?|$)/i.test(String(u))
        ? realFetch(u, o)
        : Promise.reject(new Error('offline в тесте'));
    </script></head>`)
    // Модуль подключаем сами: так видно момент готовности и можно дождаться
    // ошибки импорта, а не молча упираться в таймаут.
    .replace(/<script type="module" src="\/app\.js[^"]*"><\/script>/, `
<script>
import('/app.js')
  .then(m => { window.__app = m; window.__appReady = true; })
  .catch(e => { window.__appErr = String((e && e.stack) || e); });
</script>`);
}

// Наличие браузера определяем СИНХРОННО на верхнем уровне модуля, а не в
// before(): опция { skip } вычисляется при объявлении теста, и хук, который
// сработал бы позже, оставил бы skip === undefined — и тесты падали бы вместо
// скипа там, где браузера нет.
// Наличие браузера — синхронно на верхнем уровне, потому что опция { skip }
// вычисляется при объявлении теста, а до неё добраться должен модуль.
const skip = await skipReason({ needSkinview3d: true });
let bundle = skip ? null : await fetchSkinview3d();

let server, browser, page, base;
const pageErrors = [];

before(async () => {
  if (skip) return;
  const appJs = readFileSync(join(PUBLIC, 'app.js'));
  const capeJs = readFileSync(join(PUBLIC, 'cape-texture.js'));
  // cape-texture.js тянет соседний чистый модуль формата: без маршрута модуль
  // не загрузится, и страница не поднимется вовсе.
  const capeFormatJs = readFileSync(join(PUBLIC, 'cape-format.js'));
  // Тот же случай для api-response.js: app.js импортирует разбор ответа API.
  const apiResponseJs = readFileSync(join(PUBLIC, 'api-response.js'));
  const styles = readFileSync(join(PUBLIC, 'styles.css'));
  const cape = makeCapePng();
  const capeWings = makeCapePng(true);

  server = createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(appJs); }
    // app.js импортирует cape-texture.js: без маршрута модуль не загрузится.
    if (u === '/cape-texture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(capeJs); }
    if (u === '/cape-format.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(capeFormatJs); }
    if (u === '/api-response.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(apiResponseJs); }
    if (u === '/styles.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(styles); }
    if (u === '/skinview3d.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(bundle); }
    if (u === '/cape.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(cape); }
    if (u === '/cape-wings.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(capeWings); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(harnessHtml({ with3d: u !== '/flat' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  browser = await launchChromium();
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

// graceMs подставляет window.__capeOffscreenGrace до загрузки модуля. Тесты про
// уход за экран обязаны задавать его явно: иначе проверка «вернулась раньше, чем
// слот отпущен» меряет скорость машины — под нагрузкой два браузера с
// WebGL-контекстами растягивают пару кадров за полторы секунды, и тест падает
// на ровном коде. null — не подменять вовсе (проверка значения по умолчанию).
async function open(viewport = { width: 900, height: 700 }, path = '/', graceMs = null) {
  // Старую вкладку обязательно закрываем: тесты про уход за экран держат паузу
  // в десять минут, то есть её 14 WebGL-контекстов НЕ возвращаются в пул.
  // Копящиеся между тестами вкладки упирают Chromium в лимит, и следующий тест
  // падает сразу на первой карточке — за секунды, а не после ожидания.
  if (page) await page.close().catch(() => {});
  page = await browser.newPage({ viewport });
  page.on('pageerror', e => pageErrors.push(String(e)));
  if (graceMs !== null) {
    await page.addInitScript(ms => { window.__capeOffscreenGrace = ms; }, graceMs);
  }
  await page.goto(`${base}${path}`);
  // Ждём модуль, а не конкретную функцию: раньше здесь стоял
  // waitForFunction(() => typeof window.initCapeViewer === 'function'), и после
  // конверсии в ESM он висел до таймаута — глобалов больше нет.
  try {
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 20000 });
  } catch (e) {
    const err = await page.evaluate(() => window.__appErr || null);
    throw new Error(`app.js не загрузился: ${err || 'без сообщения'}`);
  }
  return page;
}

// Ошибки страницы, отфильтрованные до пустоты. Ожидаемые не считаем: их и так
// видно в консоли, а молчаливое «ReferenceError» — ровно тот баг, что мы ловим.
function fatalErrors() {
  return pageErrors.filter(e => !/favicon|ERR_INTERNET_DISCONNECTED|offline в тесте/.test(e));
}

// Ждём кадры, а не миллисекунды: под нагрузкой (два браузера с 14 WebGL-
// контекстами каждый) таймеры растягиваются, и проверки вроде «слот 3D ещё не
// отпущен» начинают врать. Наблюдатель реагирует на кадры, поэтому и ждать
// нужно кадры.
const frames = (n = 2) => page.evaluate(k => new Promise(r => {
  const tick = left => (left <= 0 ? r() : requestAnimationFrame(() => tick(left - 1)));
  tick(k);
}), n);

const settle = () => page.evaluate(() => new Promise(r =>
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250)))));

// Ставит N карточек и ждёт, пока вьюеры смонтируются.
//
// showView('dashboard') обязателен: сетка лежит внутри .view, а скрытые вьюхи
// помечены .hidden (display:none). IntersectionObserver не срабатывает на
// невидимых элементах, поэтому без явного показа все карточки остались бы
// пустыми — и проверка «у каждой карточки есть превью» проходила бы вхолостую
// только потому, что предыдущая сборка скрывала их.
const renderGrid = (n, url = '/cape.png') => page.evaluate(async ([count, capeUrl]) => {
  const { state, renderSkins, showView } = window.__app;
  const skins = Array.from({ length: count }, (_, i) => ({
    id: i + 1, name: 'cape' + i, tags: '', category: 'cape', url: capeUrl,
  }));
  state.user = { username: 't' };
  state.skins = skins;
  state.equipped = { cape: null };
  // Повторяем то, что делает успешный вход: navbar показан, auth скрыт.
  // Пока #view-auth не спрятан, он занимает ~1480px и уводит сетку за нижний
  // край окна — IntersectionObserver молчит, и проверка видит пустые карточки.
  document.querySelector('#navbar').classList.remove('hidden');
  document.querySelector('#view-auth').classList.add('hidden');
  showView('dashboard');
  renderSkins();
  await new Promise(r => setTimeout(r, 600));
  const cards = [...document.querySelectorAll('.skin-canvas-container')];
  // Область интереса — та же, что у IntersectionObserver в app.js.
  const onScreen = cards.filter(c => {
    const b = c.getBoundingClientRect();
    return b.bottom > -120 && b.top < innerHeight + 120;
  }).length;
  return { total: cards.length, onScreen };
}, [n, url]);
// Считает превью только у карточек, реально попавших в область зрения:
// у ушедших из экрана вьюера снять — это и есть предполагаемое поведение.
// Видимость для подсчёта повторяет параметры IntersectionObserver из app.js
// (rootMargin: '120px 0px'). Считать строго по вьюпорту нельзя: наблюдатель
// намеренно монтирует и снимает вьюеры с запасом за нижний край, и карточка
// в этом запасе обязана иметь превью.
const OBSERVER_MARGIN = 120;

const survey = () => page.evaluate(margin => {
  const cards = [...document.querySelectorAll('.skin-canvas-container')];
  const inRange = c => {
    const b = c.getBoundingClientRect();
    return b.bottom > -margin && b.top < innerHeight + margin && b.right > 0 && b.left < innerWidth;
  };
  let canvases = 0, flats = 0, blank = 0, liveCtx = 0, deadCtx = 0;
  let onScreen = 0, blankOnScreen = 0, deadOnScreen = 0;
  for (const c of cards) {
    const visible = inRange(c);
    if (visible) onScreen++;
    const cv = c.querySelector('canvas');
    // Плоское превью тоже канвас — 2D, без WebGL. getContext('webgl2') на
    // таком вернёт null, и его нельзя считать «отобранным контекстом»: сначала
    // спрашиваем 2D-контекст, он дешёвый и точно указывает на плоский вариант.
    const isFlat = cv ? !!cv.getContext('2d') : !!c.querySelector('img.cape-flat');
    if (cv && !isFlat) {
      canvases++;
      const gl = cv.getContext('webgl2') || cv.getContext('webgl');
      if (!gl || gl.isContextLost()) { deadCtx++; if (visible) deadOnScreen++; } else liveCtx++;
    } else if (cv || c.querySelector('img.cape-flat')) {
      flats++;
    } else {
      blank++;
      if (visible) blankOnScreen++;
    }
  }
  return { cards: cards.length, canvases, flats, blank, liveCtx, deadCtx, onScreen, blankOnScreen, deadOnScreen };
}, OBSERVER_MARGIN);

test('dispose() убирает <canvas> из контейнера', { skip }, async () => {
  await open();
  const r = await page.evaluate(async () => {
    const { initCapeViewer } = window.__app;
    const c = document.createElement('div');
    c.dataset.skin = '/cape.png';
    document.body.appendChild(c);
    // initCapeViewer отдаёт объект превью {dispose, demote, hasViewer}: пулу
    // вьюеров нужно отличать 3D-карточку от плоской по hasViewer().
    const preview = initCapeViewer(c, '/cape.png', 200);
    await new Promise(r => setTimeout(r, 400));
    const before = c.querySelectorAll('canvas').length;
    // hasViewer() — это то, чем пул отличает настоящий 3D-вьюер от плоской
    // заглушки, поэтому проверяем его тут же, где проверяем dispose.
    const hasViewer = preview.hasViewer();
    preview.dispose();
    return { before, after: c.querySelectorAll('canvas').length, hasViewer };
  });
  assert.equal(r.before, 1, 'вьюер должен был создать канвас');
  assert.equal(r.hasViewer, true, 'skinview3d доступен — превью должно быть 3D');
  assert.equal(r.after, 0, 'после dispose() канвас обязан исчезнуть из контейнера');
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на одной ошибке');
});

test('живых WebGL-контекстов не больше потолка, и каждая карточка что-то показывает', { skip }, async () => {
  await open({ width: 1400, height: 1400 });
  const { total, onScreen } = await renderGrid(20);
  await settle();
  const s = await survey();

  assert.equal(s.cards, total, 'все карточки должны быть в сетке');
  assert.ok(onScreen > 0, 'подсчёт бессмысленен, если на экране нет ни одной карточки');
  assert.ok(s.liveCtx <= MAX_CAPE_VIEWERS,
    `живых контекстов ${s.liveCtx}, потолок ${MAX_CAPE_VIEWERS} — Chromium отберёт самые старые`);
  assert.equal(s.deadCtx, 0, `${s.deadCtx} карточек с отобранным контекстом рисуют пустоту`);
  // Проверяем только то, что на экране: снятые из поля зрения карточки по
  // замыслу отдают вьюер, и требовать у них превью — требование багов.
  assert.equal(s.blankOnScreen, 0, `${s.blankOnScreen} карточек на экране без превью`);
  assert.equal(s.canvases + s.flats, s.onScreen, 'у каждой видимой карточки должно быть превью — 3D или плоское');
});

// Жалоба: «плащи чот переходят из одного состояния в другое — то 3D, то 2D».
// Причина была в trimViewers(): он вытеснял вьюер у видимой карточки, и
// страница мерцала. Карточка, которая не уходила с экрана, обязана сохранить
// тот же канвас — перемонтирование видно глазом как «мигание».
test('видимая карточка не переключается между 3D и 2D сама', { skip }, async () => {
  // Сетка заметно длиннее экрана: без этого window.scrollTo ничего не делает,
  // наблюдатель не срабатывает «карточка ушла» и тест проходит вхолостую.
  // Окно узкое, чтобы в зоне наблюдателя всегда было больше карточек, чем
  // потолок, — иначе вытеснять некого.
  //
  // Пауза заведомо больше всего цикла прокрутки: смысл проверки в том, что
  // вернувшаяся карточка находит свой слот 3D на месте.
  await open({ width: 1000, height: 800 }, '/', 10 * 60 * 1000);
  await renderGrid(60, '/cape-wings.png');
  await settle();
  if (0) console.log('DBG geom', JSON.stringify(await page.evaluate(() => ({
    vh: innerHeight, body: document.body.scrollHeight,
    doc: document.documentElement.scrollHeight,
    cards: document.querySelectorAll('.skin-canvas-container').length,
    canv: document.querySelectorAll('.skin-canvas-container canvas').length,
    is3d: [...document.querySelectorAll('.skin-canvas-container canvas')].filter(x => !x.getContext('2d')).length,
    scroller: (() => { const g = document.querySelector('#skins-grid'); return g ? { sh: g.scrollHeight, ch: g.clientHeight, ov: getComputedStyle(g).overflowY } : null; })(),
  }))));
  // Ждём «появились 3D-карточки И страница длиннее двух экранов». Ровно потолка
  // ждать не надо: в узком окне в зоне наблюдателя помещается меньше карточек,
  // чем потолок, — и метания ловятся на любом их количестве.
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.skin-canvas-container canvas')];
    return c.filter(x => !x.getContext('2d')).length >= 8
      && document.body.scrollHeight > innerHeight * 2;
  }, null, { timeout: 90000 });

  const marked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.skin-canvas-container')];
    // Помечаем только 3D-карточки, попавшие в экран: именно они должны
    // уцелеть при прокрутке.
    cards.forEach((c, i) => {
      const cv = c.querySelector('canvas');
      if (cv && !cv.getContext('2d')) cv.dataset.marker = 'm' + i;
    });
    return { viewers: (window.__viewers || []).length, marked: cards.filter(c => c.querySelector('canvas[data-marker]')).length };
  });
  assert.ok(marked.marked > 4, `помечено слишком мало 3D-карточек: ${marked.marked}`);

  // Прокрутка туда-сюда: верхний ряд уходит из зоны наблюдателя и возвращается.
  // Возврат быстрее отпускания слота, поэтому 3D не должен пропадать — глаз не
  // видит смены состояния, и канвас остаётся тем же объектом.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, 600));
    await frames(2);
    await page.evaluate(() => window.scrollTo(0, 0));
    await frames(2);
  }
  await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 10000 });

  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.skin-canvas-container')];
    const markedCards = cards.filter(c => c.querySelector('canvas[data-marker]'));
    return {
      viewers: (window.__viewers || []).length,
      kept: markedCards.filter(c => {
        const cv = c.querySelector('canvas');
        return cv && cv.dataset.marker;
      }).length,
      still3d: markedCards.filter(c => {
        const cv = c.querySelector('canvas');
        return cv && !cv.getContext('2d');
      }).length,
      onScreen3d: cards.filter(c => {
        const b = c.getBoundingClientRect();
        const inRange = b.bottom > -120 && b.top < innerHeight + 120;
        const cv = c.querySelector('canvas');
        return inRange && cv && !cv.getContext('2d');
      }).length,
    };
  });

  // Новые карточки при прокрутке честно занимают свободные слоты — это не
  // метание. Метание — это пересоздание вьюера у уже готовой карточки.
  assert.ok(r.viewers >= marked.viewers, 'счётчик вьюеров не должен уменьшаться при прокрутке');
  assert.equal(r.kept, marked.marked, 'канвас видимой карточки обязан остаться прежним');
  assert.equal(r.still3d, marked.marked, 'карточки не должны проваливаться в плоский вариант');
  assert.ok(r.onScreen3d >= 8, `в экране должно быть живое 3D, а не ${r.onScreen3d} плоских карточек`);
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на какой ошибке');
});

test('после циклов прокрутки у всех карточек на экране живой контекст', { skip }, async () => {
  await open({ width: 900, height: 700 });
  await renderGrid(16);
  await settle();
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await settle();
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle();
  }
  const s = await survey();
  assert.ok(s.onScreen > 0, 'подсчёт бессмысленен, если на экране нет ни одной карточки');
  assert.equal(s.deadOnScreen, 0, `${s.deadOnScreen} карточек на экране с отобранным контекстом`);
  assert.equal(s.blankOnScreen, 0, `${s.blankOnScreen} карточек на экране без превью`);
  assert.equal(s.deadCtx, 0, `${s.deadCtx} карточек с отобранным контекстом`);
});

test('renderEquipped() не гасит наблюдатель карточек', { skip }, async () => {
  await open({ width: 900, height: 700 });
  const { onScreen } = await renderGrid(16);
  await settle();
  assert.ok(onScreen > 0, 'нужна видимая сетка, иначе проверять нечего');

  // Считаем, сколько вьюеров живо ДО экипировки.
  const before = await page.evaluate(() =>
    document.querySelectorAll('.skin-canvas-container canvas').length);
  assert.ok(before > 0, 'до экипировки вьюеры должны быть смонтированы');

  await page.evaluate(() => {
    const { state, renderEquipped } = window.__app;
    state.equipped = { cape: state.skins[0] };
    renderEquipped();
  });
  await settle();

  const after = await page.evaluate(() =>
    document.querySelectorAll('.skin-canvas-container canvas').length);
  const equip = await page.evaluate(() =>
    document.querySelectorAll('#equip-cape canvas, #equip-cape img').length);

  // Настоящий признак погашенного наблюдателя: после экипировки у видимых
  // карточек не осталось НИ ОДНОГО канваса, и прокрутка их уже не вернёт —
  // observeCapeCards() больше никто не зовёт. Прежняя проверка смотрела на
  // первую карточку после прокрутки вниз и проходила в обоих случаях.
  assert.equal(after, before,
    `экипировка сняла ${before - after} вьюеров с видимых карточек — наблюдатель погашен`);

  // Возвращаем сетку в фокус: мёртвый наблюдатель не перемонтирует вьюеры.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const back = await page.evaluate(() =>
    document.querySelectorAll('.skin-canvas-container canvas').length);
  assert.ok(back > 0, 'после возврата на сетку вьюеры должны снова появиться');

  assert.equal(equip, 1, 'в слоте экипировки должно появиться превью');
});

test('повторная экипировка не падает и не течёт контекстами', { skip }, async () => {
  await open({ width: 900, height: 700 });
  await renderGrid(2);
  await settle();

  // Ключевое здесь — ДВА вызова renderEquipped() подряд. Первый сбрасывает
  // equipViewer = null, и ошибочный `equipViewer()` внутри `if (equipViewer)`
  // не вызывается вовсе — потому баг и дожил: прежний тест на renderEquipped()
  // звал функцию ровно один раз, то есть проверял только ветку «слот пуст».
  // initCapeViewer отдаёт объект {dispose, demote, hasViewer}, а не функцию,
  // поэтому второй вызов падал с «equipViewer is not a function» — и это
  // всплывало на странице тостом «Ошибка загрузки экипировки».
  const reEquip = (n) => page.evaluate(count => {
    const { state, renderEquipped } = window.__app;
    const errs = [];
    try {
      for (let i = 0; i < count; i++) {
        state.equipped = { cape: state.skins[i % state.skins.length] };
        renderEquipped();
      }
      return { errs };
    } catch (e) {
      errs.push(String((e && e.message) || e));
      return { errs };
    }
  }, n);

  const first = await reEquip(1);
  await settle();
  assert.deepEqual(first.errs, [], 'первая экипировка обязана проходить');

  const second = await reEquip(4);
  await settle();
  assert.deepEqual(second.errs, [],
    'повторная экипировка падала: ' + second.errs.join('; '));

  // В слоте должен быть ровно один канвас, а не четыре: сброшенный вьюер
  // обязан отпустить контейнер, иначе канвасы копятся.
  const equipCanvases = await page.evaluate(() =>
    document.querySelectorAll('#equip-cape canvas').length);
  assert.equal(equipCanvases, 1,
    `в слоте экипировки ${equipCanvases} канвасов вместо одного — dispose() не отпускает контейнер`);
});

test('переключение «Плащ/Крылья» работает, когда крылья есть', { skip }, async () => {
  await open({ width: 1000, height: 800 });
  await renderGrid(1, '/cape-wings.png');
  await settle();

  const st = await page.evaluate(async () => {
    const card = document.querySelector('.skin-card');
    const modes = card.querySelector('.cape-modes');
    const read = () => [...card.querySelectorAll('.cape-mode')]
      .map(b => ({ mode: b.dataset.mode, on: b.classList.contains('is-active') }));
    const before = read();
    const shown = modes ? getComputedStyle(modes).display !== 'none' : false;
    card.querySelector('.cape-mode[data-mode="elytra"]').click();
    await new Promise(r => setTimeout(r, 300));
    return { before, shown, after: read(), badge: card.querySelector('.elytra-badge').textContent };
  });

  assert.equal(st.shown, true, 'крылья нарисованы — тумблер обязан быть виден');
  assert.equal(st.badge, '✓ крылья');
  assert.deepEqual(st.before.map(b => b.on), [true, false], 'по умолчанию выбран «Плащ»');
  assert.deepEqual(st.after.map(b => b.on), [false, true],
    'клик по «Крылья» должен перенести отметку. Активный класс — is-active, как в разметке; ' +
    'при расхождении переключение перестаёт работать молча');
});

// Жалоба из прода: у части плащей «Крылья» показывали не объёмные крылья, а
// анимированную развёртку — плоский композит на карточке, которой не досталось
// WebGL-слота. Клик по «Крылья» теперь поднимает карточку в 3D, отбирая слот у
// самой давно замеченной.
test('«Крылья» поднимает плоскую карточку в 3D, а не показывает развёртку', { skip }, async () => {
  await open({ width: 1400, height: 2600 });
  await renderGrid(MAX_CAPE_VIEWERS + 4, '/cape-wings.png');
  await settle();
  await new Promise(r => setTimeout(r, 1500));

  const before = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.skin-card')];
    return {
      total: cards.length,
      flat: cards.filter(c => {
        const cv = c.querySelector('.skin-canvas-container canvas');
        return !cv || !!cv.getContext('2d');
      }).length,
      has3d: cards.filter(c => {
        const cv = c.querySelector('.skin-canvas-container canvas');
        return cv && !cv.getContext('2d');
      }).length,
    };
  });
  assert.equal(before.total, MAX_CAPE_VIEWERS + 4);
  const truth = await page.evaluate(() => {
    const c0 = document.querySelectorAll('.skin-card')[0];
    const box = c0.querySelector('.skin-canvas-container');
    const v = (window.__viewers || [])[0];
    return {
      canvases: [...box.querySelectorAll('canvas')].map(cv => ({
        w: cv.width, h: cv.height, cls: cv.className,
        two: !!cv.getContext('2d'), isViewCanvas: v ? cv === v.canvas : null,
        isCapeCanvas: v ? cv === v.capeCanvas : null,
      })),
      viewerCanvasParent: v && v.canvas && v.canvas.parentElement ? v.canvas.parentElement.className : 'нет родителя',
      inBox: v && v.canvas ? box.contains(v.canvas) : null,
    };
  });
  assert.equal(before.has3d, MAX_CAPE_VIEWERS, 'потолок: ' + JSON.stringify(truth).slice(0, 400));
  assert.ok(before.flat > 0, 'часть карточек обязана быть плоской, иначе тест ничего не проверяет');

  const after = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll('.skin-card')];
    const isFlat = c => {
      const cv = c.querySelector('.skin-canvas-container canvas');
      return !cv || !!cv.getContext('2d');
    };
    const target = cards.find(c => isFlat(c)
      && !c.querySelector('.cape-modes').classList.contains('hidden'));
    if (!target) return { error: 'нет плоской карточки с тумблером' };
    const idx = cards.indexOf(target);
    target.querySelector('.cape-mode[data-mode="elytra"]').click();
    await new Promise(r => setTimeout(r, 800));
    const back = () => {
      const v = (window.__viewers || []).find(x => x.canvas && x.canvas.closest('.skin-card') === target);
      return v && v.playerObject ? v.playerObject.backEquipment : null;
    };
    return {
      idx,
      is3dNow: !isFlat(target),
      backEquipment: back(),
      flatNow: cards.filter(isFlat).length,
      // Вытесненная карточка не должна остаться пустой.
      drawn: cards.every(c => {
        const box = c.querySelector('.skin-canvas-container');
        const cv = box.querySelector('canvas');
        if (!cv) return false;
        const ctx = cv.getContext('2d');
        if (!ctx) return true;
        return ctx.getImageData(0, 0, cv.width, cv.height).data.some(v => v !== 0);
      }),
    };
  });
  assert.equal(after.error, undefined, after.error);
  assert.equal(after.is3dNow, true, `карточка #${after.idx} осталась плоской развёрткой вместо 3D`);
  assert.equal(after.backEquipment, 'elytra', '3D-модель обязана переключиться на крылья');
  assert.equal(after.drawn, true, 'вытесненная карточка осталась без картинки');
  assert.ok(after.flatNow <= before.flat, `плоских карточек стало больше: ${before.flat} → ${after.flatNow}`);
  assert.deepEqual(fatalErrors(), []);
});

// Жалоба из прода: у плаща без крыльев кнопка «Крылья» оставалась на экране —
// рядом с бейджем «нет». Кнопка, которая ничего не показывает, выглядит как
// обещание, которое нечем выполнить.
test('тумблер «Плащ/Крылья» скрыт, когда крыльев нет', { skip }, async () => {
  await open({ width: 1000, height: 800 });
  await renderGrid(1);
  await settle();

  const st = await page.evaluate(() => {
    const card = document.querySelector('.skin-card');
    const modes = card.querySelector('.cape-modes');
    return {
      exists: !!modes,
      display: modes ? getComputedStyle(modes).display : null,
      active: [...card.querySelectorAll('.cape-mode')]
        .map(b => b.classList.contains('is-active')),
      badge: card.querySelector('.elytra-badge').textContent,
    };
  });

  assert.equal(st.exists, true, 'разметка тумблера остаётся — прячем, а не выкидываем');
  assert.equal(st.display, 'none', 'тумблер без крыльев должен быть скрыт');
  assert.equal(st.badge, 'нет', 'вердикт должен честно сказать, что крыльев нет');
  assert.deepEqual(st.active, [true, false], 'при скрытии выбор обязан вернуться на «Плащ»');
});

test('перерисовка сетки не копит канвасы', { skip }, async () => {
  await open({ width: 1000, height: 800 });
  const { total } = await renderGrid(3);
  await settle();
  assert.equal(total, 3, 'в сетке должно быть 3 карточки');

  const before = await page.evaluate(() =>
    document.querySelectorAll('.skin-canvas-container canvas').length);
  assert.ok(before > 0, 'вьюеры должны быть смонтированы');

  // Перерисовка обязана освободить прошлые вьюеры: иначе с каждым обновлением
  // накапливаются канвасы и уезжают живые WebGL-слоты.
  await renderGrid(3);
  await settle();
  const after = await page.evaluate(() =>
    document.querySelectorAll('.skin-canvas-container canvas').length);
  assert.ok(after <= before + 1,
    `после перерисовки канвасов ${after}, было ${before} — прошлые вьюеры не освобождены`);
});

test('плоский запасной вариант рисует выбранную область', { skip }, async () => {
  // Плоский путь проверяем на странице без skinview3d. С библиотекой плоская
  // карточка по клику «Крылья» уходит в 3D — там плоский вариант живёт недолго
  // и область не успевает отрисоваться (это отдельный тест, про промоушен).
  await open({ width: 1400, height: 2000 }, '/flat');
  const { total } = await renderGrid(4, '/cape-wings.png');
  await settle();
  assert.ok(total >= 4, `нужно минимум 4 карточки, встало ${total}`);

  const r = await page.evaluate(() => {
    const holders = [...document.querySelectorAll('.skin-canvas-container')];
    for (const holder of holders) {
      const cv = holder.querySelector('canvas');
      if (!cv) continue;
      const ctx = cv.getContext('2d');
      if (!ctx) continue; // это WebGL-вьюер, не наш случай
      const card = holder.closest('.skin-card');
      // Проба в режиме «Плащ» — из угла: канвас там равен грани хвоста 10×16.
      const px = () => [...ctx.getImageData(2, 2, 1, 1).data];
      const capePixel = px();
      const out = {
        found: true,
        w: cv.width,
        h: cv.height,
        capePixel,
        hasModes: !!card.querySelector('.cape-mode[data-mode="elytra"]'),
        badge: card.querySelector('.elytra-badge')?.textContent ?? null,
      };
      // Переключение на крылья: в режиме «Крылья» канвас это композит
      // «хвост + панель крыла» 21×20, поэтому пробы берём слева и справа.
      const btn = card.querySelector('.cape-mode[data-mode="elytra"]');
      if (btn) {
        btn.click();
        const next = card.querySelector('canvas');
        const nctx = next.getContext('2d');
        out.wAfter = next.width;
        out.hAfter = next.height;
        out.elytraLeft = [...nctx.getImageData(Math.round(next.width * 0.25), Math.round(next.height / 2), 1, 1).data];
        out.elytraRight = [...nctx.getImageData(Math.round(next.width * 0.75), Math.round(next.height / 2), 1, 1).data];
        out.modesAfter = [...card.querySelectorAll('.cape-mode')]
          .map(b => b.classList.contains('is-active'));
      }
      return out;
    }
    return { found: false, holders: holders.length };
  });

  assert.equal(r.found, true, 'плоского превью нет ни на одной из карточек');
  assert.ok(r.w > 0 && r.h > 0, 'канвас плоского превью должен быть непустым');
  assert.equal(r.hasModes, true, 'у плоской карточки тоже должен быть тумблер');
  // Хвост фикстуры залит цветом 201,125,64.
  assert.deepEqual(r.capePixel, [201, 125, 64, 255],
    'в режиме «Плащ» плоское превью обязано рисовать хвост, а не пустоту');
  // Крылья — цветом 64,64,201, и это ДРУГОЕ место атласа: сдвиг по x обязан
  // работать. Хвост при этом остаётся слева — как в 3D, где backEquipment=elytra
  // показывает и хвост, и крылья.
  assert.deepEqual(r.elytraLeft, [201, 125, 64, 255],
    'в режиме «Крылья» хвост должен остаться на месте');
  assert.deepEqual(r.elytraRight, [64, 64, 201, 255],
    'переключение на крылья должно рисовать область крыльев');
  // Канвас пересоздаётся под новую область: 21×20 против 10×16 у хвоста.
  assert.ok(Math.abs(r.wAfter / r.hAfter - 21 / 20) < 0.05,
    `канвас «Крыльев» должен быть под композит 21×20, получено ${r.wAfter}×${r.hAfter}`);
  assert.equal(r.badge, '✓ крылья');
  assert.deepEqual(r.modesAfter, [false, true], 'тумблер работает и в плоском варианте');
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на какой ошибке');
});

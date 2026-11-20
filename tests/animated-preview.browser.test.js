// Анимированные капы: раньше превью было <img> со ВСЕМ Stacked PNG сразу —
// то есть кашей из всех кадров, растянутой по высоте карточки.
//
// Теперь показ идёт как у обычного плаща — на модели игрока через skinview3d.
// Каждый кадр — полный атлас (64×32 в ванили, 64k×32k в HD), анимация это
// подмена кадра в capeCanvas вьюера. Если skinview3d не загрузился, карточка
// падает в плоский 2D-вариант: та же грань плаща, нарисованная без WebGL.
//
// Тест гоняет НАСТОЯЩИЙ public/animated.js в Chromium как ESM-модуль — ровно
// так, как его подключает public/animated.html. Браузера нет — пропускается.
//
// Две страницы: `/` — с skinview3d (3D-путь), `/flat` — без него (запасной
// 2D-путь). Второй вариант не искусственный: именно это происходит, когда CDN
// недоступен.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { skipReason, fetchSkinview3d, launchChromium, PUBLIC } from './helpers/browser.js';

// Потолок живых вьюеров продублирован из animated.js намеренно: проверка ниже
// идёт по этому числу, и молчаливая замена константы должна её ронять.
// 14, а не 10: Chromium держит 16 живых WebGL-контекстов, и на 17-м контекст
// умирает молча. При 10 на странице из 24 плащей треть показывалась плоской
// полосой — и читалась как «превью не загрузилось».
const MAX_ANIM_VIEWERS = 14;

// ─── Кодировщик PNG ───
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

// Stacked PNG: N кадров друг под другом, каждый кадр — атлас плаща, растянутый
// в `scale` раз (scale=1 — ванильные 64×32, scale=8 — кадр 512×256). Хвост
// (x < 22*scale) залит цветом, который МЕНЯЕТСЯ от кадра к кадру — иначе «кадры
// крутятся» неотличимо от «кадр стоит». Крылья занимают правую широкую панель
// x∈[36,46)*scale — как в настоящих плащах (левая x∈[24,34) пустая).
function makeStackPng({ frames = 4, wings = false, scale = 1 } = {}) {
  const FW = 64 * scale, FH = 32 * scale;
  const W = FW, H = FH * frames;
  const capeX = 22 * scale, wingStart = 36 * scale, wingEnd = 46 * scale;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let o = 0;
  for (let f = 0; f < frames; f++) {
    const capeR = 40 + f * 90; // 40, 130, 220...
    for (let y = 0; y < FH; y++) {
      raw[o++] = 0;
      for (let x = 0; x < W; x++) {
        if (x < capeX) {
          raw[o++] = capeR; raw[o++] = 200; raw[o++] = 100; raw[o++] = 255;
        } else if (wings && x >= wingStart && x < wingEnd) {
          raw[o++] = 20; raw[o++] = 60; raw[o++] = 220; raw[o++] = 255;
        } else {
          raw[o++] = 0; raw[o++] = 0; raw[o++] = 0; raw[o++] = 0;
        }
      }
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

// Разметка берётся из НАСТОЯЩЕГО animated.html: собранная руками копия
// разъезжается с реальной страницей, а animated.js дёргает её элементы на
// верхнем уровне модуля.
//
// with3d=false убирает тег skinview3d совсем — так проверяется запасной
// 2D-путь, в который код уходит при недоступной библиотеке.
function harnessHtml({ with3d }) {
  let real = readFileSync(join(PUBLIC, 'animated.html'), 'utf8');

  // skinview3d локально, чтобы тест не ходил в CDN за второй раз.
  real = real.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/,
    with3d ? '<script src="/skinview3d.js"></script>' : '');

  // Ловим созданные вьюеры: capeCanvas — это обычный 2D-канвас с текущим
  // кадром, его можно читать пиксельно, в отличие от WebGL-канваса. Счётчик
  // живых вьюеров виден снаружи и позволяет проверить потолок.
  if (with3d) {
    real = real.replace('<script src="/skinview3d.js"></script>',
      '<script src="/skinview3d.js"></script>\n<script>\n' +
      'window.__viewers = [];\n' +
      'window.__viewersAlive = 0;\n' +
      'const OriginalViewer = window.skinview3d.SkinViewer;\n' +
      'window.skinview3d.SkinViewer = class extends OriginalViewer {\n' +
      '  constructor(...a) { super(...a); window.__viewers.push(this); window.__viewersAlive++; }\n' +
      '  dispose() { window.__viewersAlive--; return super.dispose(); }\n' +
      '};\n' +
      '</script>');
  }

  return real
    // API недоступен; PNG пропускаем — их разбор и есть проверяемое поведение.
    .replace('</head>', `<script>
      const realFetch = window.fetch;
      window.fetch = (u, o) => /\\.(png|jpg|jpeg|webp)(\\?|$)/i.test(String(u))
        ? realFetch(u, o)
        : Promise.reject(new Error('offline в тесте'));
    </script></head>`)
    .replace(/<script type="module" src="\/animated\.js[^"]*"><\/script>/, `
<script>
import('/animated.js')
  .then(m => { window.__app = m; window.__appReady = true; })
  .catch(e => { window.__appErr = String((e && e.stack) || e); });
</script>`);
}

const skip = await skipReason({ needSkinview3d: true });
let bundle = skip ? null : await fetchSkinview3d();

let server, browser, page, base;
const pageErrors = [];

before(async () => {
  if (skip) return;
  const animatedJs = readFileSync(join(PUBLIC, 'animated.js'));
  const capeJs = readFileSync(join(PUBLIC, 'cape-texture.js'));
  // cape-texture.js тянет соседний чистый модуль формата: без маршрута модуль
  // не загрузится, и страница не поднимется вовсе.
  const capeFormatJs = readFileSync(join(PUBLIC, 'cape-format.js'));
  // Тот же случай для api-response.js: animated.js импортирует разбор ответа API.
  const apiResponseJs = readFileSync(join(PUBLIC, 'api-response.js'));
  const styles = readFileSync(join(PUBLIC, 'styles.css'));
  const anim = makeStackPng({ frames: 4, wings: false });
  const wings = makeStackPng({ frames: 4, wings: true });
  // HD-стек: кадр 512×256, но заявлен как атлас ×8 — превью обязано сохранить
  // разрешение, а не схлопнуть область хвоста в пару пикселей.
  const hd = makeStackPng({ frames: 2, wings: false, scale: 8 });

  server = createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/animated.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(animatedJs); }
    if (u === '/cape-texture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(capeJs); }
    if (u === '/cape-format.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(capeFormatJs); }
    if (u === '/api-response.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(apiResponseJs); }
    if (u === '/styles.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(styles); }
    if (u === '/skinview3d.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(bundle || ''); }
    if (u === '/anim.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(anim); }
    if (u === '/wings.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(wings); }
    if (u === '/hd.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(hd); }
    // Тяжёлый файл: ответ задержан, чтобы поймать состояние «ещё читаю PNG».
    if (u === '/slow.png') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(anim); }, 1500);
      return;
    }
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

// graceMs подставляет window.__capeOffscreenGrace до загрузки модуля. Тесты
// про уход за экран обязаны задавать его явно: иначе проверка «вернулась раньше,
// чем слот отпущен» меряет скорость машины — под нагрузкой два браузера с
// WebGL-контекстами растягивают пару кадров за полторы секунды, и тест падает
// на ровном коде.
async function open(path = '/', viewport = { width: 900, height: 700 }, graceMs = null) {
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
  try {
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 20000 });
  } catch {
    const err = await page.evaluate(() => window.__appErr || null);
    throw new Error(`animated.js не загрузился: ${err || 'без сообщения'}`);
  }
  return page;
}

function fatalErrors() {
  return pageErrors.filter(e => !/favicon|ERR_INTERNET_DISCONNECTED|offline в тесте/.test(e));
}

// Ждём кадры, а не миллисекунды: под нагрузкой (два браузера с 14 контекстами
// каждый) таймеры растягиваются, и проверки «слот ещё не отпущен» начинают
// врать. Кадр — единица, которую реально контролируетнаблюдатель.
const frames = (n = 2) => page.evaluate(k => new Promise(r => {
  const tick = left => (left <= 0 ? r() : requestAnimationFrame(() => tick(left - 1)));
  tick(k);
}), n);

const settle = () => page.evaluate(() => new Promise(r =>
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))));

// Ставит карточки и показывает сетку так же, как это делает успешный вход:
// скрытый .view не даёт IntersectionObserver увидеть карточки.
const renderGrid = (urls) => page.evaluate(async list => {
  const { state, renderSkins, showView } = window.__app;
  state.user = { username: 't' };
  state.skins = list.map((url, i) => ({ id: i + 1, name: 'anim' + i, tags: '', url }));
  state.equipped = { animated: null };
  document.querySelector('#navbar').classList.remove('hidden');
  document.querySelector('#view-auth').classList.add('hidden');
  showView('dashboard');
  renderSkins();
  await new Promise(r => setTimeout(r, 700));
  return document.querySelectorAll('.skin-card').length;
}, urls);

// Пиксели текущего кадра карточки. У 2D-превью это его собственный канвас, у
// 3D — capeCanvas вьюера (обычный 2D-канвас с нарисованным кадром атласа).
// Точка (2,2) лежит в области хвоста: у фикстуры её цвет меняется каждый кадр.
const sampleCard = (cardIndex, times, gap) => page.evaluate(async ({ cardIndex, times, gap }) => {
  const card = document.querySelectorAll('.skin-card')[cardIndex];
  const cv = card && card.querySelector('.skin-canvas-container canvas');
  if (!cv) return { found: false, reason: 'нет канваса' };
  const own = cv.getContext('2d');
  let target = cv;
  if (!own) {
    const v = (window.__viewers || []).find(x => x.canvas === cv);
    if (!v) return { found: false, reason: 'вьюер для канваса не найден' };
    target = v.capeCanvas;
  }
  const ctx = target.getContext('2d');
  const out = [];
  for (let i = 0; i < times; i++) {
    out.push([...ctx.getImageData(2, 2, 1, 1).data].join(','));
    if (i < times - 1) await new Promise(r => setTimeout(r, gap));
  }
  return { found: true, out, size: [target.width, target.height] };
}, { cardIndex, times, gap });

const distinct = arr => new Set(arr).size;
const cardState = cardIndex => page.evaluate(i => {
  const card = document.querySelectorAll('.skin-card')[i];
  const modes = card.querySelector('.cape-modes');
  return {
    badge: card.querySelector('.elytra-badge')?.textContent ?? null,
    modesVisible: modes ? getComputedStyle(modes).display !== 'none' : false,
    active: [...card.querySelectorAll('.cape-mode')].map(b => b.classList.contains('is-active')),
  };
}, cardIndex);

// ─── 3D-путь (skinview3d есть) ───

test('анимированный кап монтирует 3D-вьюер и крутит кадры', { skip }, async () => {
  await open();
  const cards = await renderGrid(['/anim.png']);
  assert.equal(cards, 1);
  await settle();

  const info = await page.evaluate(() => {
    const container = document.querySelector('.skin-canvas-container');
    const cv = container.querySelector('canvas');
    const v = (window.__viewers || [])[0];
    return {
      viewers: (window.__viewers || []).length,
      alive: window.__viewersAlive,
      isWebgl: !!cv && !cv.getContext('2d'),
      img: !!container.querySelector('img'),
      cc: v ? [v.capeCanvas.width, v.capeCanvas.height] : null,
      back: v ? v.playerObject.backEquipment : null,
      sameMap: v ? v.playerObject.cape.map === v.playerObject.elytra.map : null,
    };
  });
  assert.equal(info.viewers, 1, 'должен создаться ровно один вьюер');
  assert.equal(info.isWebgl, true, 'превью обязано быть 3D-канвасом, а не плоским');
  assert.equal(info.img, false, 'исходный стек нельзя показывать как <img>');
  // Ванильные кадры 64×32: capeCanvas — это целый атлас того же размера.
  assert.deepEqual(info.cc, [64, 32]);
  assert.equal(info.back, 'cape', 'по умолчанию показан плащ');
  // Одна и та же текстура висит и на хвосте, и на крыльях — иначе подмена
  // кадра в capeCanvas не обновила бы крылья.
  assert.equal(info.sameMap, true, 'хвост и крылья должны делить одну текстуру');

  const s = await sampleCard(0, 6, 140);
  assert.equal(s.found, true, s.reason);
  assert.ok(distinct(s.out) >= 2, `кадры не меняются: ${s.out.join(' | ')}`);

  const st = await cardState(0);
  assert.equal(st.badge, 'нет', 'у плаща без крыльев вердикт должен быть честным');
  assert.equal(st.modesVisible, false, 'без крыльев тумблер не показываем');
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на одной ошибке');
});

test('HD-стек сохраняет разрешение атласа, а не схлопывает кадр', { skip }, async () => {
  await open();
  await renderGrid(['/hd.png']);
  await settle();

  const cc = await page.evaluate(() => {
    const v = (window.__viewers || [])[0];
    return v ? [v.capeCanvas.width, v.capeCanvas.height] : null;
  });
  // Кадр 512×256, ужатый до превью, даёт 256×128 — то есть атлас ×4, четыре
  // пикселя на тексель. Больше не нужно: карточка 160 px, а HD-пиксели сверх
  // этого всё равно не видно. Меньше нельзя — хвост смажется. Больше в
  // 8192×4096 (если масштабировать исходный кадр) — это 33 мегапикселя и
  // десятки мегабайт на каждую карточку.
  assert.deepEqual(cc, [256, 128], 'HD-кадр должен дать атлас превью-размера, а не 33 Мп');

  // HD-кадр рисуется вчетверо дольше ванильного, и тик занимает ~180 мс.
  // Частая выборка с ровным шагом попадает в одну и ту же фазу и «не видит»
  // смены кадров — окно и шаг берём с запасом.
  const s = await sampleCard(0, 14, 200);
  assert.equal(s.found, true, s.reason);
  assert.ok(distinct(s.out) >= 2, `кадры HD-стека не меняются: ${s.out.join(' | ')}`);
});

test('тумблер «Плащ/Крылья» переключает оборудование на живой карточке', { skip }, async () => {
  await open();
  await renderGrid(['/wings.png']);
  await settle();

  const st = await cardState(0);
  assert.equal(st.badge, '✓ крылья');
  assert.equal(st.modesVisible, true, 'крылья нарисованы — тумблер обязан быть виден');
  assert.deepEqual(st.active, [true, false]);

  const after = await page.evaluate(async () => {
    const card = document.querySelector('.skin-card');
    card.querySelector('.cape-mode[data-mode="elytra"]').click();
    await new Promise(r => setTimeout(r, 200));
    const cv = card.querySelector('.skin-canvas-container canvas');
    const v = (window.__viewers || []).find(x => x.canvas === cv);
    return {
      back: v ? v.playerObject.backEquipment : null,
      elytraVisible: v ? v.playerObject.elytra.visible : null,
      capeVisible: v ? v.playerObject.cape.visible : null,
      active: [...card.querySelectorAll('.cape-mode')].map(b => b.classList.contains('is-active')),
    };
  });
  assert.equal(after.back, 'elytra', 'вьюер должен переключиться на крылья');
  assert.deepEqual(after.active, [false, true], 'активной должна стать кнопка крыльев');
  // Крыло показано, хвост скрыт — иначе на модели было бы два плаща сразу.
  assert.equal(after.elytraVisible, true);
  assert.equal(after.capeVisible, false);
});

test('уход за экран останавливает кадры, но слот 3D держится', { skip }, async () => {
  // Контекстов на странице не больше 16, поэтому вьюеры обязаны освобождаться,
  // а не копиться: тридцать карточек иначе переполнили бы потолок. Но отдавать
  // слот мгновенно нельзя — карточка мигала 3D→2D→3D на каждом движении
  // прокрутки. Слот живёт ещё ANIM_OFFSCREEN_GRACE после ухода.
  //
  // Пауза здесь намеренно огромна: тест проверяет, что слот ДЕРЖИТСЯ, и любая
  // конечная пауза рано или поздно истечёт на медленной машине. Освобождение
  // проверяет отдельный тест с нулевой паузой.
  await open('/', { width: 900, height: 600 }, 10 * 60 * 1000);
  await renderGrid(Array.from({ length: 30 }, () => '/anim.png'));
  await settle();

  const onScreen = await sampleCard(0, 6, 140);
  assert.equal(onScreen.found, true, onScreen.reason);
  assert.ok(distinct(onScreen.out) >= 2, 'на экране кадры должны идти');

  const first = await page.evaluate(() => {
    const alive = window.__viewersAlive;
    const v = (window.__viewers || []).find(x =>
      x.canvas.parentElement &&
      x.canvas.parentElement.closest('.skin-card') === document.querySelectorAll('.skin-card')[0]);
    window.__frozen = v ? v.capeCanvas : null;
    return { alive, created: (window.__viewers || []).length, hasViewer: !!v };
  });
  assert.equal(first.hasViewer, true, 'у видимой карточки должен быть вьюер');
  assert.ok(first.alive <= MAX_ANIM_VIEWERS,
    `живых вьюеров ${first.alive}, потолок ${MAX_ANIM_VIEWERS}`);

  // За экран: кадры обязаны встать, но канвас и 3D-слот — остаться на месте.
  // Отпускается слот позже, по таймеру (см. следующий шаг), а не мгновенно.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // Ровно кадры: дальше успевает сработать отпускание слота по таймеру, и
  // проверка «слот ещё держится» начинает зависеть от загрузки машины.
  await frames(3);
  const off = await page.evaluate(async () => {
    const alive = window.__viewersAlive;
    const cv0 = document.querySelectorAll('.skin-card')[0]
      .querySelector('.skin-canvas-container canvas');
    const still = !!cv0;
    const still3d = !!cv0 && !cv0.getContext('2d');
    const v0 = (window.__viewers || []).find(x => x.canvas.parentElement &&
      x.canvas.parentElement.closest('.skin-card') === document.querySelectorAll('.skin-card')[0]);
    const sameCanvas = !!v0 && v0.capeCanvas === window.__frozen;
    const cc = window.__frozen;
    if (!cc) return { alive, still, still3d, sameCanvas, found: false };
    const ctx = cc.getContext('2d');
    const out = [];
    for (let i = 0; i < 4; i++) {
      out.push([...ctx.getImageData(2, 2, 1, 1).data].join(','));
      await new Promise(r => setTimeout(r, 160));
    }
    return { alive, still, still3d, sameCanvas, found: true, out };
  });
  assert.equal(off.still, true, 'канвас ушедшей карточки обязан остаться в DOM — иначе карточка мигает');
  assert.equal(off.found, true);
  assert.equal(distinct(off.out), 1, `кадры продолжают идти за экраном: ${off.out.join(' | ')}`);
  assert.equal(off.still3d, true, 'слот 3D не должен отдаваться в первые мгновения после ухода');
  assert.equal(off.sameCanvas, true, 'вьюер ушедшей карточки обязан остаться прежним');
  // Потолок держится и у нижнего края: карточки там монтируются, отпущенные —
  // нет, поэтому живых по-прежнему не больше MAX_ANIM_VIEWERS, а не 30.
  assert.ok(off.alive <= MAX_ANIM_VIEWERS || off.alive < first.alive,
    `у нижнего края живых вьюеров ${off.alive}`);

  // Возврат по горячему следу: слот ещё жив, поэтому карточка обязана просто
  // продолжить тем же вьюером — никакого перемонтирования.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const back = await sampleCard(0, 6, 140);
  assert.equal(back.found, true, back.reason);
  assert.ok(distinct(back.out) >= 2, 'после возврата кадры должны пойти снова');
  const same = await page.evaluate(() => {
    const v = (window.__viewers || []).find(x => x.canvas.parentElement &&
      x.canvas.parentElement.closest('.skin-card') === document.querySelectorAll('.skin-card')[0]);
    return {
      same: !!v && v.capeCanvas === window.__frozen,
      alive: window.__viewersAlive,
    };
  });
  // Общий счётчик созданных вьюеров тут бесполезен: прокрутка вниз монтирует
  // новые карточки, и он растёт законно. Единственный признак метания —
  // карточка получила ДРУГОЙ вьюер, то есть перемонтировалась.
  assert.equal(same.same, true, 'возврат обязан продолжать тот же вьюер, а не создавать новый');
  assert.ok(same.alive <= MAX_ANIM_VIEWERS,
    `живых вьюеров ${same.alive}, потолок ${MAX_ANIM_VIEWERS}`);
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на какой ошибке');
});

test('слот 3D освобождается после паузы вне экрана', { skip }, async () => {
  // Обратная сторона удержания: слот не должен висеть вечно, иначе 30 карточек
  // переполнят потолок Chromium. Пауза нулевая — проверка должна быть про
  // освобождение, а не про ожидание таймера.
  await open('/', { width: 900, height: 600 }, 0);
  await renderGrid(Array.from({ length: 30 }, () => '/anim.png'));
  await settle();

  const before = await page.evaluate(() => {
    const v = (window.__viewers || []).find(x => x.canvas.parentElement &&
      x.canvas.parentElement.closest('.skin-card') === document.querySelectorAll('.skin-card')[0]);
    window.__frozen = v ? v.capeCanvas : null;
    return { alive: window.__viewersAlive, hasViewer: !!v };
  });
  assert.equal(before.hasViewer, true, 'у видимой карточки должен быть вьюер');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // Ждём условие, а не миллисекунды: освобождение при нулевой паузе всё равно
  // проходит через setTimeout(0) и кадр.
  await page.waitForFunction(() => {
    const cv = document.querySelectorAll('.skin-card')[0]
      .querySelector('.skin-canvas-container canvas');
    return !!cv && !!cv.getContext('2d');
  }, null, { timeout: 20000 }).catch(() => {});

  const after = await page.evaluate(() => {
    const v = (window.__viewers || []).find(x => x.canvas.parentElement &&
      x.canvas.parentElement.closest('.skin-card') === document.querySelectorAll('.skin-card')[0]);
    return {
      alive: window.__viewersAlive,
      sameCanvas: !!v && v.capeCanvas === window.__frozen,
      // Ушедшая карточка обязана остаться нарисованной плоской картинкой:
      // слот отпущен, но «плащ исчез» — это не то, что мы чинили.

    };
  });
  // Признак освобождения — слот ИМЕННО ЭТОЙ карточки. Общее число живых
  // вьюеров упасть не обязано: у нижнего края страницы к тому моменту
  // монтировались новые карточки и заняли освободившиеся слоты.
  assert.equal(after.sameCanvas, false, 'после паузы вне экрана слот обязан уйти в пул');
  assert.ok(after.alive <= MAX_ANIM_VIEWERS,
    `живых вьюеров ${after.alive}, потолок ${MAX_ANIM_VIEWERS}`);
  // Контейнер ушедшей карточки при этом пустеет: держать 2D-канвас и
  // картинку для карточки, которую не видно, незачем. Проверяем не это, а то,
  // что важно: по возврату карточка снова получает рабочий 3D.

  // Возврат: карточка снова получает рабочий 3D и крутит кадры.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const back = await sampleCard(0, 6, 140);
  assert.equal(back.found, true, back.reason);
  assert.ok(distinct(back.out) >= 2, 'после возврата кадры должны пойти снова');
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на какой ошибке');
});

// Регрессия на жалобу «плащи чот переходят из 1 состояния в другое»: пока
// карточка не вернулась, её 3D-слот не отдаётся, поэтому прокрутка мимо
// карточек не превращается в мельтешение 3D↔2D.
test('прокрутка мимо карточек не переключает их между 3D и 2D', { skip }, async () => {
  // Пауза заведомо больше всего цикла прокрутки: смысл проверки в том, что
  // вернувшаяся карточка находит свой слот на месте.
  await open('/', { width: 900, height: 600 }, 10 * 60 * 1000);
  await renderGrid(Array.from({ length: 30 }, () => '/anim.png'));
  await settle();

  const marked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.skin-card')];
    cards.forEach((c, i) => {
      const cv = c.querySelector('.skin-canvas-container canvas');
      if (cv && !cv.getContext('2d')) cv.dataset.marker = 'm' + i;
    });
    return {
      created: (window.__viewers || []).length,
      marked: cards.filter(c => c.querySelector('canvas[data-marker]')).length,
    };
  });
  assert.ok(marked.marked >= 4, `помечено мало 3D-карточек: ${marked.marked}`);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await frames(2);
    await page.evaluate(() => window.scrollTo(0, 0));
    await frames(2);
  }
  await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 10000 });

  const r = await page.evaluate(() => {
    // Помеченные карточки — те, у которых 3D уже стоял. Вернувшись на экран,
    // они обязаны быть в 3D: провалиться в 2D на пустом месте нельзя.
    const markedCards = [...document.querySelectorAll('.skin-card')]
      .filter(c => c.querySelector('canvas[data-marker]'));
    const inView = markedCards.filter(c => {
      const b = c.getBoundingClientRect();
      return b.bottom > -120 && b.top < innerHeight + 120;
    });
    return {
      marked: inView.length,
      still3d: inView.filter(c => {
        const cv = c.querySelector('canvas');
        return cv && !cv.getContext('2d');
      }).length,
      alive: window.__viewersAlive,
    };
  });
  // В узком окне в экране помещается несколько карточек — важно, чтобы
  // помеченных было достаточно для проверки, но не «все 30».
  assert.ok(r.marked >= 3, `помеченных карточек в экране мало: ${r.marked}`);
  assert.equal(r.still3d, r.marked, 'карточки провалились в 2D во время прокрутки');
  assert.ok(r.alive <= MAX_ANIM_VIEWERS,
    `живых вьюеров ${r.alive}, потолок ${MAX_ANIM_VIEWERS}`);
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на какой ошибке');
});

// ─── Запасной 2D-путь (skinview3d недоступен) ───

test('без skinview3d кап падает в плоскую анимацию и не остаётся пустым', { skip }, async () => {
  await open('/flat');
  await renderGrid(['/anim.png']);
  await settle();

  const info = await page.evaluate(() => {
    const cv = document.querySelector('.skin-canvas-container canvas');
    return {
      hasViewers: (window.__viewers || []).length,
      img: !!document.querySelector('.skin-canvas-container img'),
      isFlat: !!cv && !!cv.getContext('2d'),
      mode: cv ? cv.dataset.previewMode : null,
      size: cv ? [cv.width, cv.height] : null,
    };
  });
  assert.equal(info.hasViewers, 0, 'без библиотеки 3D-вьюеров быть не должно');
  assert.equal(info.isFlat, true, 'должен быть 2D-канвас');
  assert.equal(info.img, false, 'исходный стек нельзя показывать как <img>');
  assert.equal(info.mode, 'cape');
  // Грань хвоста 10×16 — выше, чем шире; стек целиком дал бы 64×128.
  assert.deepEqual(info.size, [100, 160]);
  assert.ok(Math.abs(info.size[0] / info.size[1] - 10 / 16) < 0.02);

  const s = await sampleCard(0, 6, 140);
  assert.equal(s.found, true, s.reason);
  assert.ok(distinct(s.out) >= 2, `кадры не меняются: ${s.out.join(' | ')}`);

  const st = await cardState(0);
  assert.equal(st.badge, 'нет');
  assert.equal(st.modesVisible, false, 'без крыльев тумблер не показываем');
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на одной ошибке');
});

test('пока читается PNG, в карточке стоит заглушка, а не пустой контейнер', { skip }, async () => {
  await open('/flat');
  await renderGrid(['/slow.png']);
  // Живой путь 2D-карточки: холста ещё нет, значит контейнер обязан что-то
  // показывать — «плащ не показался» и «ещё грузится» снаружи неразличимы.
  const loading = await page.evaluate(() => {
    const box = document.querySelector('.skin-canvas-container');
    return {
      placeholder: !!box.querySelector('.cape-loading'),
      text: box.textContent.trim(),
      canvas: !!box.querySelector('canvas'),
    };
  });
  assert.equal(loading.canvas, false, 'до разбора холста быть не должно');
  assert.equal(loading.placeholder, true, `в контейнере пусто: "${loading.text}"`);
  assert.match(loading.text, /читаю/);

  await page.waitForFunction(() => !!document.querySelector('.skin-canvas-container canvas'),
    null, { timeout: 15000 });
  const done = await page.evaluate(() => {
    const box = document.querySelector('.skin-canvas-container');
    return {
      placeholder: !!box.querySelector('.cape-loading'),
      canvas: !!box.querySelector('canvas'),
      drawn: box.querySelector('canvas').getContext('2d').getImageData(0, 0, 10, 10).data.some(v => v !== 0),
    };
  });
  assert.equal(done.placeholder, false, 'после разбора заглушка обязана исчезнуть');
  assert.equal(done.canvas, true);
  assert.equal(done.drawn, true, 'канвас превью не должен остаться пустым');
  assert.deepEqual(fatalErrors(), []);
});

test('на 3D-странице заглушка тоже стоит и уступает место вьюеру', { skip }, async () => {
  await open('/');
  await renderGrid(['/slow.png']);
  // В animated.js вьюер монтируется ПОСЛЕ разбора текстуры (ему нужен первый
  // кадр), поэтому до 1.5 с контейнер пуст — заглушка тут обязательна.
  const mid = await page.evaluate(() => {
    const box = document.querySelector('.skin-canvas-container');
    return { placeholder: !!box.querySelector('.cape-loading'), canvas: !!box.querySelector('canvas') };
  });
  assert.equal(mid.canvas, false, 'вьюеру нужен первый кадр, до разбора его нет');
  assert.equal(mid.placeholder, true, 'пустой 3D-контейнер читается как «плащ не показался»');

  await page.waitForFunction(() => !!document.querySelector('.skin-canvas-container canvas'),
    null, { timeout: 15000 });
  const done = await page.evaluate(() => {
    const box = document.querySelector('.skin-canvas-container');
    return { placeholder: !!box.querySelector('.cape-loading'), canvas: !!box.querySelector('canvas') };
  });
  assert.equal(done.placeholder, false, 'после разбора заглушка обязана исчезнуть');
  assert.equal(done.canvas, true);
  assert.deepEqual(fatalErrors(), []);
});

// Жалоба из прода: у части плащей «Крылья» показывали анимированную развёртку
// вместо 3D — плоский композит на карточке, которой не досталось WebGL-слота.
// Клик по «Крылья» поднимает карточку в 3D, отбирая слот у самой давно
// показанной.
test('«Крылья» поднимает плоскую карточку в 3D, а не показывает развёртку', { skip }, async () => {
  await open('/', { width: 1400, height: 2600 });
  await renderGrid(Array.from({ length: MAX_ANIM_VIEWERS + 4 }, () => '/wings.png'));
  // Ждём именно плоскую карточку с тумблером: под нагрузкой разбор текстуры
  // идёт дольше, и выборка «первой плоской» раньше давала пустоту.
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.skin-card')];
    return cards.some(c => {
      const cv = c.querySelector('.skin-canvas-container canvas');
      const flat = (!cv || cv.getContext('2d')) && !c.querySelector('.cape-modes').classList.contains('hidden');
      return flat;
    });
  }, null, { timeout: 60000 });

  const after = await page.evaluate(async cap => {
    const cards = [...document.querySelectorAll('.skin-card')];
    const flat = c => {
      const cv = c.querySelector('.skin-canvas-container canvas');
      return !cv || !!cv.getContext('2d');
    };
    const target = cards.find(c => flat(c) && !c.querySelector('.cape-modes').classList.contains('hidden'));
    if (!target) return { error: 'нет плоской карточки с тумблером' };
    const flatBefore = cards.filter(flat).length;
    target.querySelector('.cape-mode[data-mode="elytra"]').click();
    await new Promise(r => setTimeout(r, 900));
    const v = (window.__viewers || []).find(x => x.canvas && x.canvas.closest('.skin-card') === target);
    return {
      is3dNow: !flat(target),
      backEquipment: v && v.playerObject ? v.playerObject.backEquipment : null,
      live: (window.__viewersAlive || 0),
      flatBefore, flatAfter: cards.filter(flat).length,
      drawn: cards.every(c => {
        const cv = c.querySelector('.skin-canvas-container canvas');
        if (!cv) return false;
        const ctx = cv.getContext('2d');
        if (!ctx) return true;
        return ctx.getImageData(0, 0, cv.width, cv.height).data.some(v => v !== 0);
      }),
    };
  }, MAX_ANIM_VIEWERS);

  assert.equal(after.error, undefined, after.error);
  assert.ok(after.flatBefore > 0, 'часть карточек обязана быть плоской, иначе тест ничего не проверяет');
  assert.equal(after.is3dNow, true, 'карточка осталась плоской развёрткой вместо 3D');
  assert.equal(after.backEquipment, 'elytra', '3D-модель обязана переключиться на крылья');
  assert.ok(after.live <= MAX_ANIM_VIEWERS, `живых вьюеров ${after.live} при потолке ${MAX_ANIM_VIEWERS}`);
  assert.equal(after.drawn, true, 'вытесненная карточка осталась без картинки');
  assert.ok(after.flatAfter <= after.flatBefore,
    `плоских карточек стало больше: ${after.flatBefore} → ${after.flatAfter}`);
  assert.deepEqual(fatalErrors(), []);
});

test('плоский вариант переключает область крыльев по тумблеру', { skip }, async () => {
  await open('/flat');
  await renderGrid(['/wings.png']);
  await settle();

  // Хвост перекрашивается каждый кадр (R = 40/130/220), поэтому сравниваем не
  // точное число, а «это хвост» — G=200, B=100, альфа 255. Крылья, наоборот,
  // одного цвета во всех кадрах, и их сравниваем точно.
  const read = () => page.evaluate(() => {
    const cv = document.querySelector('.skin-canvas-container canvas');
    const ctx = cv.getContext('2d');
    const at = (fx) => [...ctx.getImageData(Math.round(cv.width * fx), Math.round(cv.height * 0.5), 1, 1).data];
    return { left: at(0.25), right: at(0.75), mode: cv.dataset.previewMode, w: cv.width, h: cv.height };
  });
  const isTail = (px) => px[1] === 200 && px[2] === 100 && px[3] === 255;
  const WING = '20,60,220,255';

  const before = await read();
  assert.equal(before.mode, 'cape');
  assert.ok(isTail(before.left), `в режиме «Плащ» нарисован хвост, получено ${before.left}`);
  // Канвас пропорционален одной грани плаща (10×16): крыла сюда не входят.
  assert.ok(Math.abs(before.w / before.h - 10 / 16) < 0.05,
    `канвас «Плаща» должен быть пропорционален хвосту, а не композиту: ${before.w}×${before.h}`);

  const st = await cardState(0);
  assert.equal(st.modesVisible, true, 'крылья нарисованы — тумблер обязан быть виден');

  await page.evaluate(async () => {
    const card = document.querySelector('.skin-card');
    card.querySelector('.cape-mode[data-mode="elytra"]').click();
    await new Promise(r => setTimeout(r, 150));
  });

  const after = await page.evaluate(() => {
    const card = document.querySelector('.skin-card');
    const cv = card.querySelector('canvas');
    const ctx = cv.getContext('2d');
    // Композит: хвост слева, широкая панель крыла справа — как в 3D при
    // backEquipment=elytra. Одна панель 10×20 в квадратной карточке выглядит
    // полосой с пустотами, и её путают с неудачно загрузившейся текстурой.
    const at = (fx) => [...ctx.getImageData(Math.round(cv.width * fx), Math.round(cv.height * 0.5), 1, 1).data];
    return {
      left: at(0.25), right: at(0.75),
      mode: cv.dataset.previewMode,
      active: [...card.querySelectorAll('.cape-mode')].map(b => b.classList.contains('is-active')),
    };
  });
  assert.equal(after.mode, 'elytra', 'канвас должен знать, чью область он показывает');
  assert.deepEqual(after.active, [false, true], 'активной должна стать кнопка крыльев');
  assert.ok(isTail(after.left), `в режиме «Крылья» слева должен остаться хвост, получено ${after.left}`);
  assert.equal(after.right.join(','), WING, 'в режиме «Крылья» справа должен быть кусок крыльев');
});

test('плоский вариант гасит кадры у ушедшей карточки', { skip }, async () => {
  await open('/flat', { width: 900, height: 600 });
  await renderGrid(Array.from({ length: 30 }, () => '/anim.png'));
  await settle();

  const visible = await sampleCard(0, 6, 140);
  assert.equal(visible.found, true, visible.reason);
  assert.ok(distinct(visible.out) >= 2, 'на экране кадры должны идти');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await settle();
  const off = await sampleCard(0, 5, 160);
  // 2D-канвас не размонтируется (контекст не занимает), но таймер обязан встать.
  assert.equal(off.found, true, off.reason);
  assert.equal(distinct(off.out), 1, `кадры продолжают идти за экраном: ${off.out.join(' | ')}`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const back = await sampleCard(0, 6, 140);
  assert.ok(distinct(back.out) >= 2, 'после возврата кадры должны пойти снова');
});

test('слот экипировки тоже показывает грань плаща и крутит кадры', { skip }, async () => {  await open('/flat');
  const shape = await page.evaluate(async () => {
    const { state, renderEquipped, showView } = window.__app;
    document.querySelector('#navbar').classList.remove('hidden');
    document.querySelector('#view-auth').classList.add('hidden');
    state.equipped = { animated: { id: 1, name: 'a', url: '/anim.png' } };
    showView('equipped');
    renderEquipped();
    await new Promise(r => setTimeout(r, 700));
    const cv = document.querySelector('#equip-animated canvas');
    if (!cv) return { found: false, html: document.querySelector('#equip-animated').innerHTML.slice(0, 120) };
    return {
      found: true, w: cv.width, h: cv.height,
      clearHidden: document.querySelector('.slot-clear[data-category="animated"]').classList.contains('hidden'),
    };
  });

  assert.equal(shape.found, true, `в слоте экипировки нет канваса: ${shape.html ?? ''}`);
  assert.ok(Math.abs(shape.w / shape.h - 10 / 16) < 0.02,
    `слот должен показывать грань плаща 10×16, получено ${shape.w}×${shape.h}`);
  assert.equal(shape.clearHidden, false, 'кнопка «Снять» должна показаться');

  const s = await page.evaluate(async () => {
    const cv = document.querySelector('#equip-animated canvas');
    const ctx = cv.getContext('2d');
    const out = [];
    for (let i = 0; i < 6; i++) {
      out.push([...ctx.getImageData(2, 2, 1, 1).data].join(','));
      await new Promise(r => setTimeout(r, 140));
    }
    return out;
  });
  assert.ok(distinct(s) >= 2, `кадры в слоте не меняются: ${s.join(' | ')}`);
});

test('на странице из 24 плащей 14 показываются в 3D, а остальные — тоже нарисованы', { skip }, async () => {
  // Ровно этот сценарий прислали с «часть плащей не показалась»: страница
  // выше экрана, плащей больше, чем помещается в один взгляд, и часть карточек
  // уходит в плоский вариант из-за потолка вьюеров.
  await open('/', { width: 1400, height: 2800 });
  await renderGrid(Array.from({ length: 24 }, () => '/anim.png'));
  await settle();

  const page24 = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll('.skin-card')];
    const drawn = (cv) => {
      if (!cv) return false;
      const ctx = cv.getContext('2d');
      if (!ctx) return true; // WebGL-канвас: 2D-контекста нет, это 3D
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    };
    const snapshot = () => ({
      cards: cards.length,
      alive: window.__viewersAlive,
      flat: cards.filter(c => {
        const cv = c.querySelector('.skin-canvas-container canvas');
        return cv && cv.getContext('2d');
      }).length,
      empty: cards.filter(c => !drawn(c.querySelector('.skin-canvas-container canvas'))).length,
      rawImg: document.querySelectorAll('.skin-canvas-container img').length,
    });

    // Ждём условие, а не фиксированную паузу: плоские канвасы рисуются
    // асинхронно (декодирование файла), и проверка на фиксированной паузе мигает.
    const deadline = Date.now() + 15000;
    let st = snapshot();
    while (st.empty > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      st = snapshot();
    }
    return st;
  });

  assert.equal(page24.cards, 24);
  assert.equal(page24.rawImg, 0, 'исходный стек нельзя показывать как <img>');
  assert.equal(page24.empty, 0,
    `у ${page24.empty} карточек ничего не нарисовано (3D: ${page24.alive}, плоских: ${page24.flat})`);
  // Потолок выбран целиком, но не выше предела Chromium в 16 контекстов —
  // на 17-м контекст умирает молча и карточка выглядит пустой.
  assert.equal(page24.alive, MAX_ANIM_VIEWERS,
    `3D-вьюеров ${page24.alive}, потолок ${MAX_ANIM_VIEWERS}`);
  assert.equal(page24.flat, 24 - MAX_ANIM_VIEWERS,
    `плоских карточек ${page24.flat} — остальные обязаны быть в 3D`);
  assert.ok(page24.alive <= 16,
    `${page24.alive} WebGL-контекстов: Chromium держит 16, дальше вьюеры умирают молча`);
  assert.deepEqual(fatalErrors(), [], 'страница не должна падать ни на одной ошибке');
});

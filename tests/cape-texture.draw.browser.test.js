// Отрисовка превью в настоящем браузере: loadTexture, нарезка области,
// проигрыватель кадров стека.
//
// Юнит-тесты ловят координаты, но не ловят ошибку «нарезали не тот
// прямоугольник»: пиксели сравниваются здесь. Скип, если нет Chromium.
//
// Запуск: node --test tests/
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { skipReason, startHarness } from './helpers/browser.js';
import { capeAtlas, stackedPng, encodePng } from './helpers/png.js';

const skip = await skipReason();

// Цвета подобраны так, чтобы хвост и крылья различались не только формой:
// атлас с синим хвостом и красными крыльями позволяет отличить их по пикселям.
const CAPE_RGB = [40, 80, 220];
const ELYTRA_RGB = [220, 40, 40];

const at = ([r, g, b]) => [r, g, b, 255];

// Хвост синий, крылья красные на заданной доле.
function twoToneAtlas(elytraCover) {
  return encodePng(64, 32, (x, y) => {
    if (x < 22 && y < 17) return at(CAPE_RGB);
    if (x >= 22 && x < 46 && y < Math.round(22 * elytraCover)) return at(ELYTRA_RGB);
    return [0, 0, 0, 0];
  });
}

let h;

before(async () => {
  if (skip) return;
  const files = {
    '/two-tone.png': twoToneAtlas(1),
    '/no-wings.png': twoToneAtlas(0),
    '/narrow.png': encodePng(22, 17, (x, y) => (y < 17 ? at(CAPE_RGB) : [0, 0, 0, 0])),
    // HD-атлас: тот же рисунок, что у /two-tone.png, но 2048×1024 (32 текселя
    // на ванильный пиксель). Такой кадр skinview3d принимает, а старый кроп
    // области 22×17 сжимал его в 3×2 пикселя.
    '/hd.png': encodePng(2048, 1024, (x, y) => {
      if (x < 22 * 32 && y < 17 * 32) return at(CAPE_RGB);
      if (x >= 22 * 32 && x < 46 * 32 && y < 22 * 32) return at(ELYTRA_RGB);
      return [0, 0, 0, 0];
    }),
    '/stack.png': stackedPng({
      frames: 3, frameWidth: 64, frameHeight: 32,
      description: 'Stacked PNG: 3 frames 64x32, order=down',
      // Каждый кадр — свой оттенок синего, чтобы отличать их между собой.
      painter: frame => at([20 + frame * 40, 60, 200]),
    }),
    '/stack-lie.png': stackedPng({
      frames: 3, frameWidth: 64, frameHeight: 32,
      description: 'Stacked PNG: 99 frames 64x32, order=down',
    }),
    // 100×70: ни 2:1, ни 22:17, ни 46:22 — и на 2:1 не делится, так что это
    // не стек кадров, а просто не-плащ. 100×100 подошло бы, но там ровно два
    // кадра 100×50, и код верно назвал бы такой файл атласом 2:1.
    '/not-a-cape.png': encodePng(100, 70, () => at(CAPE_RGB)),
    // Раскладка настоящих плащей: крылья только в правой широкой панели
    // x∈[36,46), y∈[2,22); левая x∈[24,34) пустая.
    '/right-wings.png': encodePng(64, 32, (x, y) => {
      if (x < 22 && y < 17) return at(CAPE_RGB);
      if (x >= 36 && x < 46 && y >= 2 && y < 22) return at(ELYTRA_RGB);
      return [0, 0, 0, 0];
    }),
  };

  // Настоящий модуль с диска: тест обязан ломаться, когда правят его код.
  const source = readFileSync(new URL('../public/cape-texture.js', import.meta.url));
  // Чистый слой формата лежит рядом и импортируется первым — без маршрута
  // модуль не загрузится, и страница не поднимется вовсе.
  const formatSource = readFileSync(new URL('../public/cape-format.js', import.meta.url));

  const shell = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import * as cape from '/cape-texture.js';
window.cape = cape;
window.ready = true;
</script></body></html>`;

  h = await startHarness({
    routes(req, res) {
      const url = req.url.split('?')[0];
      if (url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(shell);
        return true;
      }
      if (url === '/cape-texture.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(source);
        return true;
      }
      if (url === '/cape-format.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(formatSource);
        return true;
      }
      if (files[url]) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(files[url]);
        return true;
      }
      return false;
    },
  });

  await h.goto();
  await h.page.waitForFunction(() => window.ready === true);
});

after(async () => {
  if (h) await h.close();
});

test('loadTexture() разбирает настоящий файл с диска', { skip }, async () => {
  const t = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/two-tone.png');
    return {
      width: tex.width, height: tex.height,
      frames: tex.geometry.frames,
      source: tex.geometry.source,
      kind: tex.kind.kind,
      hasElytraRoom: tex.kind.hasElytraRoom,
      cape: tex.cape.coverage,
      elytra: tex.elytra.coverage,
      verdict: tex.verdict.level,
      canvas: [tex.canvas.width, tex.canvas.height],
    };
  });
  assert.deepEqual([t.width, t.height], [64, 32]);
  assert.equal(t.frames, 1);
  assert.equal(t.kind, 'full');
  assert.equal(t.hasElytraRoom, true);
  assert.equal(t.cape, 1, 'хвост закрашен целиком');
  assert.ok(t.elytra > 0.3, `крылья закрашены, покрытие ${t.elytra}`);
  assert.equal(t.verdict, 'yes');
});

test('loadTexture() берёт число кадров из заголовка мода', { skip }, async () => {
  const t = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/stack.png');
    return { frames: tex.geometry.frames, source: tex.geometry.source, warnings: tex.warnings };
  });
  assert.equal(t.frames, 3);
  assert.equal(t.source, 'meta');
  assert.deepEqual(t.warnings, []);
});

test('loadTexture() не верит заголовку, который врёт про файл', { skip }, async () => {
  const t = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/stack-lie.png');
    return { frames: tex.geometry.frames, source: tex.geometry.source, warnings: tex.warnings };
  });
  assert.equal(t.frames, 3, 'по пропорции 2:1 в файле ровно 3 кадра');
  assert.equal(t.source, 'guess');
  assert.match(t.warnings.join(' '), /99/);
});

test('loadTexture() различает три исхода проверки крыльев', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const one = async url => (await window.cape.loadTexture(url)).verdict.level;
    return {
      withWings: await one('/two-tone.png'),
      noWings: await one('/no-wings.png'),
      narrow: await one('/narrow.png'),
      notCape: await one('/not-a-cape.png'),
    };
  });
  assert.equal(out.withWings, 'yes');
  assert.equal(out.noWings, 'none');
  // Атлас 22×17 — крыльям негде быть, это не то же самое, что «нет крыльев».
  assert.equal(out.narrow, 'no-room');
  assert.equal(out.notCape, 'unknown');
});

test('loadTexture() падает на не-PNG, а не возвращает пустоту', { skip }, async () => {
  const message = await h.page.evaluate(async () => {
    try {
      await window.cape.loadTexture('/missing.png');
      return null;
    } catch (e) {
      return e.message;
    }
  });
  assert.match(String(message), /404/);
});

test('extractRegion() режет хвост и крылья из разных мест атласа', { skip }, async () => {
  // Ключевая проверка: крылья лежат в x∈[22,46). Со сдвигом по x, забытым в
  // regionRect, «элитры» показывали бы кусок хвоста.
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/two-tone.png');
    const sample = (bounds) => {
      const canvas = window.cape.extractRegion(tex, bounds, 0, 64);
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      return { r: r / n, g: g / n, b: b / n, w: canvas.width, h: canvas.height };
    };
    return {
      cape: sample(window.cape.CAPE_BOUNDS),
      elytra: sample(window.cape.ELYTRA_BOUNDS),
    };
  });

  // Хвост синий: синего канала заметно больше красного.
  assert.ok(out.cape.b > out.cape.r + 80, `хвост должен быть синим, получили ${JSON.stringify(out.cape)}`);
  // Крылья красные: наоборот.
  assert.ok(out.elytra.r > out.elytra.b + 80, `крылья должны быть красными, получили ${JSON.stringify(out.elytra)}`);
  // Пропорции областей разные — и канвасы разные.
  assert.ok(out.cape.w > out.cape.h, 'хвост 22×17 шире, чем выше');
  assert.ok(out.elytra.w > out.elytra.h, 'крылья 24×22 шире, чем выше');
});

test('extractRegion() у плаща без крыльев даёт честную пустоту', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/no-wings.png');
    const canvas = window.cape.extractRegion(tex, window.cape.ELYTRA_BOUNDS, 0, 64);
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) opaque++;
    return { opaque, total: d.length / 4 };
  });
  assert.equal(out.opaque, 0, 'в области крыльев ничего не нарисовано — выдумывать нечего');
});

test('previewCanvas() подгоняет размер под пропорции области', { skip }, async () => {
  const out = await h.page.evaluate(() => {
    const size = 200;
    const c = window.cape.previewCanvas(size, window.cape.CAPE_BOUNDS);
    const e = window.cape.previewCanvas(size, window.cape.ELYTRA_BOUNDS);
    const f = window.cape.previewCanvas(size, window.cape.CAPE_FACE);
    const g = window.cape.previewCanvas(size, window.cape.ELYTRA_FACE);
    return { c: [c.width, c.height], e: [e.width, e.height], f: [f.width, f.height], g: [g.width, g.height] };
  });
  // 22:17 и 24:22 — разные пропорции, значит и канвасы разные.
  assert.deepEqual(out.c, [200, 155]); // round(200 / (22/17)) = 155
  assert.deepEqual(out.e, [200, 183]); // round(200 / (24/22)) = 183
  // Грани для плоского превью: 10:16 и 10:20 — выше, чем шире.
  assert.deepEqual(out.f, [125, 200]);
  assert.deepEqual(out.g, [100, 200]);
});

// Регрессия из прода: на плаще 2048×1024 область 22×17 — это 88×68 пикселей,
// а не 3×2. Со старым множителем (previewScale) карточка HD-плаща показывала
// лоскут в пару пикселей, и «нихуя не видно» было буквально верным.
test('extractRegion() на HD-кадре режет область в правильном масштабе', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/hd.png');
    const sample = bounds => {
      const canvas = window.cape.extractRegion(tex, bounds, 0, 0);
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, g = 0, b = 0, opaque = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; opaque++; n++;
      }
      return { w: canvas.width, h: canvas.height, r: r / n, g: g / n, b: b / n, opaque };
    };
    return {
      scale: tex.scale,
      atlasScale: tex.atlasScale,
      cape: sample(window.cape.CAPE_BOUNDS),
      elytra: sample(window.cape.ELYTRA_BOUNDS),
      face: sample(window.cape.CAPE_FACE),
    };
  });
  assert.equal(out.scale, 0.125);
  assert.equal(out.atlasScale, 4);
  // До фикса было [3, 2]: обе координаты области умножались на previewScale.
  assert.deepEqual([out.cape.w, out.cape.h], [88, 68]);
  assert.deepEqual([out.elytra.w, out.elytra.h], [96, 88]);
  // Грань хвоста 10×16 → 40×64.
  assert.deepEqual([out.face.w, out.face.h], [40, 64]);
  // Цвета совпадают с атласом: хвост синий, крылья красные, и x-сдвиг верный.
  assert.ok(out.cape.b > out.cape.r + 80, `хвост должен быть синим: ${JSON.stringify(out.cape)}`);
  assert.ok(out.elytra.r > out.elytra.b + 80, `крылья должны быть красными: ${JSON.stringify(out.elytra)}`);
  assert.ok(out.cape.opaque > 0 && out.elytra.opaque > 0);
});

test('createFramePlayer() листает кадры стека и останавливается', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/stack.png');
    const canvas = window.cape.previewCanvas(64, window.cape.CAPE_BOUNDS);
    document.body.appendChild(canvas);
    const sig = () => {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let s = '';
      for (let i = 0; i < d.length; i += 4) s += String(d[i]);
      return s;
    };
    const player = window.cape.createFramePlayer(60);
    player.start(canvas.getContext('2d'), tex, window.cape.CAPE_BOUNDS);
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 40));
      seen.add(sig());
    }
    const running = player.running;
    player.stop();
    const frameAtStop = player.frame;
    const frozen = sig();
    await new Promise(r => setTimeout(r, 150));
    return {
      distinct: seen.size,
      running,
      frameAtStop,
      frameAfterWait: player.frame,
      frozenAfterStop: sig() === frozen,
    };
  });

  assert.equal(out.running, true, 'проигрыватель должен крутиться');
  assert.ok(out.distinct > 1, `кадры стека должны отличаться, увидел ${out.distinct} вариантов`);
  assert.equal(out.frozenAfterStop, true, 'после stop() картинка не должна меняться');
  // Стоп не должен отматывать анимацию: застываем там, где остановились.
  assert.equal(out.frameAfterWait, out.frameAtStop, 'после stop() номер кадра не должен прыгать');
});

test('createFramePlayer() перерисовывает ту же текстуру в другую область', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/two-tone.png');
    const canvas = window.cape.previewCanvas(64, window.cape.CAPE_BOUNDS);
    const player = window.cape.createFramePlayer();
    player.start(canvas.getContext('2d'), tex, window.cape.CAPE_BOUNDS);
    // Один и тот же канал (красный) до и после: иначе сравниваются разные
    // каналы разных цветов и сравнение всегда проходит.
    const red = () => canvas.getContext('2d').getImageData(0, 0, 4, 4).data[0];
    const before = red();
    player.setBounds(window.cape.ELYTRA_BOUNDS);
    const after = red();
    player.stop();
    return { before, after };
  });
  // Хвост синий — красного канала почти нет. Крылья красные — он залит.
  assert.ok(out.before < 80, `до переключения канвас был синим, красный канал ${out.before}`);
  assert.ok(out.after > 180, `после переключения канвас красный, красный канал ${out.after}`);
});

test('paintFrame() кладёт составную область рядом, одним масштабом', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/two-tone.png');
    // Хвост синий, крылья красные — части различимы по каналу.
    const bounds = { parts: [window.cape.CAPE_FACE, window.cape.ELYTRA_FACE], gap: 1 };
    const canvas = window.cape.previewCanvas(210, bounds);
    const ok = window.cape.paintFrame(canvas.getContext('2d'), tex, 0, bounds);
    const ctx = canvas.getContext('2d');
    const row = (y) => [...ctx.getImageData(0, y, canvas.width, 1).data];
    const colors = (y) => {
      const d = row(y);
      const out2 = [];
      for (let x = 0; x < canvas.width; x += 7) out2.push([d[x * 4], d[x * 4 + 1], d[x * 4 + 2], d[x * 4 + 3]].join(','));
      return out2;
    };
    return {
      ok,
      w: canvas.width, h: canvas.height,
      middle: colors(Math.round(canvas.height / 2)),
    };
  });
  assert.equal(out.ok, true);
  // 10 + gap 1 + 10 = 21 тексель атласа в ширину, 20 в высоту.
  assert.ok(Math.abs(out.w / out.h - 21 / 20) < 0.05,
    `составная область должна давать почти квадрат 21×20, получено ${out.w}×${out.h}`);
  // Хвост CAPE_RGB слева, крылья ELYTRA_RGB справа, между ними — прозрачная щель.
  const TAIL = CAPE_RGB.concat([255]).join(',');
  const WING = ELYTRA_RGB.concat([255]).join(',');
  const seen = [...new Set(out.middle)];
  assert.ok(out.middle.includes(TAIL), `слева должен быть хвост ${TAIL}, в строке: ${seen.join(' | ')}`);
  assert.ok(out.middle.includes(WING), `справа должно быть крыло ${WING}, в строке: ${seen.join(' | ')}`);
  assert.ok(out.middle.includes('0,0,0,0'), 'между хвостом и крылом должен быть зазор, иначе они слипнутся');
  // Хвост идёт ПЕРЕД крылом: в 3D так же.
  assert.ok(out.middle.indexOf(TAIL) < out.middle.indexOf(WING),
    `хвост должен быть слева, крыло справа: ${out.middle.join(' ')}`);
});

test('paintFrame() одной областью ведёт себя как раньше', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/two-tone.png');
    const single = window.cape.previewCanvas(100, window.cape.CAPE_FACE);
    const alsoSingle = window.cape.previewCanvas(100, [window.cape.CAPE_FACE]);
    const ok = window.cape.paintFrame(single.getContext('2d'), tex, 0, window.cape.CAPE_FACE);
    window.cape.paintFrame(alsoSingle.getContext('2d'), tex, 0, [window.cape.CAPE_FACE]);
    return {
      ok,
      w: single.width, h: single.height,
      w2: alsoSingle.width, h2: alsoSingle.height,
      same: [...single.getContext('2d').getImageData(0, 0, single.width, single.height).data]
        .join(',') === [...alsoSingle.getContext('2d').getImageData(0, 0, alsoSingle.width, alsoSingle.height).data].join(','),
    };
  });
  assert.equal(out.ok, true);
  assert.deepEqual([out.w, out.h], [out.w2, out.h2], 'массив из одной части — это обычная область');
  assert.equal(out.same, true, 'рисование должно совпасть до пикселя');
});

test('createFramePlayer() не крутит одиночный кадр', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/two-tone.png');
    const canvas = window.cape.previewCanvas(64, window.cape.CAPE_BOUNDS);
    const player = window.cape.createFramePlayer(60);
    player.start(canvas.getContext('2d'), tex, window.cape.CAPE_BOUNDS);
    const running = player.running;
    player.stop();
    return { running, frames: tex.geometry.frames };
  });
  assert.equal(out.frames, 1);
  assert.equal(out.running, false, 'у одиночного плаща таймер запускаться не должен');
});

test('loadTexture() не течёт на битом файле и не бросает необъяснённое', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const good = await window.cape.loadTexture('/two-tone.png');
    return { verdict: good.verdict.ok, level: good.verdict.level, hint: good.verdict.hint.length > 0 };
  });
  assert.equal(out.verdict, true);
  assert.equal(out.level, 'yes');
  assert.equal(out.hint, true, 'у вердикта должно быть пояснение для подсказки');
});

test('ELYTRA_FACE указывает на панель с крыльями, а не на пустую', { skip }, async () => {
  const out = await h.page.evaluate(async () => {
    const tex = await window.cape.loadTexture('/right-wings.png');
    const read = face => {
      const c = window.cape.extractRegion(tex, face);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return { w: c.width, h: c.height, opaque: +(n / (d.length / 4)).toFixed(2) };
    };
    return {
      face: { x: window.cape.ELYTRA_FACE.x, y: window.cape.ELYTRA_FACE.y },
      chosen: read(window.cape.ELYTRA_FACE),
      empty: read({ x: 24, y: 2, w: 10, h: 20 }),
      cape: read(window.cape.CAPE_FACE),
      verdict: tex.verdict.level,
    };
  });
  // На 15 файлах с прода покрытие крыльев в [36,2] — 0.44–0.88, в [24,2] — ноль.
  assert.deepEqual(out.face, { x: 36, y: 2 });
  assert.equal(out.chosen.opaque, 1, 'выбранная панель обязана быть залита целиком');
  assert.equal(out.chosen.w, 10);
  assert.equal(out.chosen.h, 20);
  assert.equal(out.empty.opaque, 0, 'левая панель у настоящих плащей пустая');
  assert.equal(out.cape.opaque, 1, 'хвост должен остаться синим');
  assert.equal(out.verdict, 'yes');
});

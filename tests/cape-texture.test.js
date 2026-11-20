// Текстура плаща: разбор PNG, геометрия стека кадров, UV-боксы, проверка крыльев.
//
// Модуль браузерный, но всё, кроме loadTexture(), — чистые функции без DOM,
// поэтому тесты гоняются обычным `node --test` без браузера.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ATLAS_W, ATLAS_H,
  CAPE_BOX, ELYTRA_BOX, CAPE_BOUNDS, ELYTRA_BOUNDS, CAPE_FACE, ELYTRA_FACE,
  ELYTRA_WEAK_MIN, ELYTRA_YES_MIN,
  isPng, readPngHeader, readPngTextChunks,
  parseStackedDescription, stackGeometry, atlasKind,
  boxFaces, analyzeRegion, analyzeFrame, judgeElytra,
  previewScale, frameRect, regionRect, pngTransparency,
} from '../public/cape-texture.js';

import { encodePng, rgbPng, palettePng, capeAtlas, stackedPng, imageData } from './helpers/png.js';

const bytes = buf => new Uint8Array(buf);

// ─── Сигнатура и заголовок ───

test('isPng() узнаёт настоящий PNG и не ведётся на мусор', () => {
  assert.equal(isPng(bytes(capeAtlas())), true);
  assert.equal(isPng(bytes(Buffer.from('GIF89a'))), false);
  assert.equal(isPng(bytes(Buffer.alloc(0))), false);
  // Обрезанная под сигнатуру — тоже не PNG.
  assert.equal(isPng(bytes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))), false);
  assert.equal(isPng(null), false);
  assert.equal(isPng(undefined), false);
});

test('readPngHeader() читает настоящий IHDR', () => {
  const png = bytes(capeAtlas());
  // Глубина и тип цвета тоже читаются: по ним сайт понимает, есть ли в файле
  // прозрачность, ещё до декодирования пикселей.
  assert.deepEqual(readPngHeader(png), { width: 64, height: 32, bitDepth: 8, colorType: 6 });
  assert.deepEqual(readPngHeader(bytes(stackedPng({
    frames: 3, frameWidth: 46, frameHeight: 22,
  }))), { width: 46, height: 66, bitDepth: 8, colorType: 6 });
});

test('readPngHeader() отличает битый IHDR от не-PNG', () => {
  assert.equal(readPngHeader(bytes(Buffer.from('не png вовсе'))), null);

  // Сигнатура есть, но длина IHDR не 13 — заголовок врёт.
  const bad = Buffer.from(capeAtlas());
  bad.writeUInt32BE(11, 8);
  assert.equal(readPngHeader(bytes(bad)), null);

  // Сигнатура есть, IHDR есть, но файл обрезан на середине.
  assert.equal(readPngHeader(bytes(Buffer.from(capeAtlas()).subarray(0, 20))), null);
});

// ─── Текстовые чанки ───

test('readPngTextChunks() читает tEXt — ровно то, что пишет мод капов', () => {
  const png = bytes(stackedPng({
    frames: 2, frameWidth: 64, frameHeight: 32,
    description: 'Stacked PNG: 2 frames 64x32, order=down',
  }));
  const text = readPngTextChunks(png);
  assert.equal(text.Description, 'Stacked PNG: 2 frames 64x32, order=down');
});

test('readPngTextChunks() читает iTXt с не-ASCII значением', () => {
  const png = bytes(encodePng(64, 32, () => [0, 0, 0, 0], {
    itxt: { Description: 'Stacked PNG: 1 frames 64x32, order=down — ёлка' },
  }));
  const text = readPngTextChunks(png);
  assert.equal(text.Description, 'Stacked PNG: 1 frames 64x32, order=down — ёлка');
});

test('readPngTextChunks() игнорирует zTXt — так же, как сам мод', () => {
  const png = bytes(encodePng(64, 32, () => [0, 0, 0, 0], {
    ztxt: { Description: 'Stacked PNG: 9 frames 64x32, order=down' },
  }));
  assert.equal(readPngTextChunks(png).Description, undefined);
});

test('readPngTextChunks() не вылезает за пределы файла на обрезанном чанке', () => {
  const png = Buffer.from(capeAtlas());
  // Обрезаем файл так, что длина объявленного чанка уходит за конец.
  const cut = png.subarray(0, 40);
  assert.doesNotThrow(() => readPngTextChunks(bytes(cut)));
  assert.deepEqual(readPngTextChunks(bytes(cut)), {});
});

// ─── Заголовок Stacked PNG ───

test('parseStackedDescription() разбирает формат мода', () => {
  assert.deepEqual(parseStackedDescription('Stacked PNG: 11 frames 256x128, order=down'),
    { frames: 11, frameWidth: 256, frameHeight: 128, order: 'down' });
  // Без order — мод пишет down по умолчанию.
  assert.deepEqual(parseStackedDescription('Stacked PNG: 3 frames 64x32'),
    { frames: 3, frameWidth: 64, frameHeight: 32, order: 'down' });
  // Символ × вместо x, разный регистр, лишние пробелы.
  assert.deepEqual(parseStackedDescription('stacked png:  4   frames  46×22 , ORDER=Down'),
    { frames: 4, frameWidth: 46, frameHeight: 22, order: 'down' });
});

test('parseStackedDescription() не выдумывает заголовок', () => {
  for (const junk of ['', 'обычный плащ', 'Stacked PNG без чисел', null, undefined, 42]) {
    assert.equal(parseStackedDescription(junk), null, `ожидался null для ${JSON.stringify(junk)}`);
  }
});

// ─── Геометрия стека ───

test('stackGeometry() доверяет заголовку, когда он сходится с файлом', () => {
  const g = stackGeometry(256, 1408, 'Stacked PNG: 11 frames 256x128, order=down');
  assert.equal(g.frames, 11);
  assert.equal(g.frameWidth, 256);
  assert.equal(g.frameHeight, 128);
  assert.equal(g.source, 'meta');
  assert.deepEqual(g.warnings, []);
});

test('stackGeometry() не доверяет заголовку, если он врёт про файл', () => {
  // Заголовок обещает 11 кадров, а в файле их 10.
  const g = stackGeometry(256, 1280, 'Stacked PNG: 11 frames 256x128, order=down');
  assert.equal(g.frames, 10, 'режем по пропорции 2:1, как это делает мод');
  assert.equal(g.source, 'guess');
  assert.match(g.warnings.join(' '), /заголовке 11 × 256×128, а файл 256×1280/);
});

test('stackGeometry() предупреждает про неподдерживаемый порядок кадров', () => {
  const g = stackGeometry(256, 512, 'Stacked PNG: 4 frames 256x128, order=right');
  assert.match(g.warnings.join(' '), /порядок кадров «right» не поддерживается/);
  // Кадры всё равно насчитали — показывать что-то надо.
  assert.equal(g.frames, 4);
  assert.equal(g.source, 'guess');
});

test('stackGeometry() считает одиночный плащ одним кадром', () => {
  const g = stackGeometry(64, 32, null);
  assert.deepEqual(
    { frames: g.frames, frameWidth: g.frameWidth, frameHeight: g.frameHeight, source: g.source },
    { frames: 1, frameWidth: 64, frameHeight: 32, source: 'single' },
  );
});

test('stackGeometry() не нарезает файл, который не кратен 2:1', () => {
  // 64×100: кадр был бы 64×32, а 100 не делится на 32 — резать нельзя.
  const g = stackGeometry(64, 100, null);
  assert.equal(g.frames, 1);
  assert.equal(g.source, 'single');
});

// ─── Форма файла ───

test('atlasKind() узнаёт все три допустимые пропорции', () => {
  assert.deepEqual(
    (({ kind, scale, hasElytraRoom }) => ({ kind, scale, hasElytraRoom }))(atlasKind(64, 32)),
    { kind: 'full', scale: 1, hasElytraRoom: true },
  );
  // 22×17 — только хвост, крыльям места нет.
  assert.deepEqual(
    (({ kind, scale, hasElytraRoom }) => ({ kind, scale, hasElytraRoom }))(atlasKind(22, 17)),
    { kind: 'cape-only', scale: 1, hasElytraRoom: false },
  );
  // 46×22 — хвост плюс крылья, тоже полный.
  assert.deepEqual(
    (({ kind, scale, hasElytraRoom }) => ({ kind, scale, hasElytraRoom }))(atlasKind(46, 22)),
    { kind: 'full', scale: 1, hasElytraRoom: true },
  );
});

test('atlasKind() масштабирует нестандартный размер к сетке 64×32', () => {
  // 128×64 — тот же 2:1, вдвое крупнее атласа.
  assert.equal(atlasKind(128, 64).scale, 2);
  // 32×16 — тот же 2:1, вчетверо мельче.
  assert.equal(atlasKind(32, 16).scale, 0.5);
  // 92×44 — 46×22 вдвое.
  assert.equal(atlasKind(92, 44).scale, 2);
  // 44×34 — 22×17 вдвое.
  assert.equal(atlasKind(44, 34).scale, 2);
});

test('atlasKind() отвергает то, что не текстура плаща', () => {
  for (const [w, h] of [[100, 100], [0, 32], [64, 0], [-64, 32], [1.5, 0.75], [NaN, 32]]) {
    const kind = atlasKind(w, h);
    assert.equal(kind.kind, 'unsupported', `${w}×${h} не должно проходить`);
    assert.equal(kind.scale, null);
    assert.equal(kind.hasElytraRoom, false);
  }
  assert.match(atlasKind(100, 100).reason, /100×100 не похож/);
});

// ─── UV-боксы ───

test('boxFaces() раскладывает бокс ровно как skinview3d', () => {
  // Эталон сверен с функцией Aa() из skinview3d 3.4.2 (bundle.min.js):
  // она строит UV шести граней BoxGeometry из четырёх прямоугольников
  // l(u+d,v, u+w+d,v+d), l(u+w+d,v, u+2w+d,v+d), l(u,v+d, u+d,v+h+d),
  // l(u+d,v+d, u+w+d,v+h+d), l(u+w+d,v+d, u+w+2d,v+h+d),
  // l(u+w+2d,v+d, u+2w+2d,v+h+d). Список ниже — не пересказ, а сверка.
  assert.deepEqual(boxFaces(CAPE_BOX), [
    [1, 0, 11, 1],
    [11, 0, 21, 1],
    [0, 1, 1, 17],
    [1, 1, 11, 17],
    [11, 1, 12, 17],
    [12, 1, 22, 17],
  ]);
  assert.deepEqual(boxFaces(ELYTRA_BOX), [
    [24, 0, 34, 2],
    [34, 0, 44, 2],
    [22, 2, 24, 22],
    [24, 2, 34, 22],
    [34, 2, 36, 22],
    [36, 2, 46, 22],
  ]);
});

test('шесть граней не накладываются друг на друга', () => {
  // Иначе заполненность считалась бы по одним и тем же текселям дважды и
  // порог 8% поехал бы. Сумма площадей — это ровно 372 и 520 текселя:
  // столько же, сколько дала калибровка по настоящим файлам.
  for (const [box, total, name] of [[CAPE_BOX, 372, 'хвост'], [ELYTRA_BOX, 520, 'крылья']]) {
    const seen = new Set();
    let sum = 0;
    for (const [x0, y0, x1, y1] of boxFaces(box)) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const key = `${x},${y}`;
          assert.equal(seen.has(key), false, `${name}: тексель ${key} посчитан дважды`);
          seen.add(key);
        }
      }
      sum += (x1 - x0) * (y1 - y0);
    }
    assert.equal(sum, total, `${name}: сумма площадей граней`);
    assert.equal(seen.size, total, `${name}: грань с нулевой площадью или перекрытие`);
  }
});

test('UV-боксы хвоста и крыльев не перекрываются', () => {
  // Это главное, на чём держится проверка крыльев: если бы области делили
  // тексели, заполненность хвоста засчиталась бы за крылья.
  const cape = new Set();
  for (const [x0, y0, x1, y1] of boxFaces(CAPE_BOX)) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cape.add(`${x},${y}`);
  }
  const elytra = new Set();
  for (const [x0, y0, x1, y1] of boxFaces(ELYTRA_BOX)) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) elytra.add(`${x},${y}`);
  }
  assert.ok(cape.size > 0 && elytra.size > 0);
  for (const key of cape) assert.equal(elytra.has(key), false, `тексель ${key} попал в оба бокса`);
});

test('UV-боксы целиком лежат в своих видимых прямоугольниках', () => {
  for (const [box, bounds, name] of [[CAPE_BOX, CAPE_BOUNDS, 'хвост'], [ELYTRA_BOX, ELYTRA_BOUNDS, 'крылья']]) {
    for (const [x0, y0, x1, y1] of boxFaces(box)) {
      assert.ok(x0 >= bounds.x, `${name}: грань начинается левее ${bounds.x}`);
      assert.ok(y0 >= bounds.y, `${name}: грань начинается выше ${bounds.y}`);
      assert.ok(x1 <= bounds.x + bounds.w, `${name}: грань уходит вправо за ${bounds.x + bounds.w}`);
      assert.ok(y1 <= bounds.y + bounds.h, `${name}: грань уходит вниз за ${bounds.y + bounds.h}`);
    }
  }
});

test('размеры боксов совпадают с размерами видимых областей', () => {
  // 10×16 — панель хвоста 22×17 с запасом на глубину; 10×20 — крыло 24×22.
  assert.equal(CAPE_BOX.w, 10);
  assert.equal(CAPE_BOX.h, 16);
  assert.equal(ELYTRA_BOX.w, 10);
  assert.equal(ELYTRA_BOX.h, 20);
  assert.equal(ATLAS_W, 64);
  assert.equal(ATLAS_H, 32);
});

// ─── Заполненность ───

test('analyzeFrame() видит нарисованные крылья и не видит пустых', () => {
  const empty = imageData(64, 32, (x, y) => (x < 22 && y < 17 ? [201, 125, 64, 255] : [0, 0, 0, 0]));
  const a = analyzeFrame(empty, 1);
  assert.equal(a.cape.coverage, 1, 'хвост закрашен целиком');
  assert.equal(a.elytra.coverage, 0, 'крылья пустые');

  const withElytra = imageData(64, 32, (x, y) => {
    if (x < 22 && y < 17) return [201, 125, 64, 255];
    if (x >= 22 && x < 46 && y < 11) return [212, 90, 74, 255]; // ровно половина высоты
    return [0, 0, 0, 0];
  });
  const b = analyzeFrame(withElytra, 1);
  assert.equal(b.cape.coverage, 1);
  assert.ok(b.elytra.coverage > 0.4 && b.elytra.coverage < 0.6,
    `ожидалось около половины области крыльев, получили ${b.elytra.coverage.toFixed(3)}`);
});

test('analyzeRegion() считает прозрачный шум как незанятое', () => {
  // Пиксель с нулевой альфой не должен считаться нарисованным, даже если
  // цвет яркий.
  const image = imageData(64, 32, (x, y) => (x < 22 && y < 17 ? [255, 0, 255, 0] : [0, 0, 0, 0]));
  assert.equal(analyzeRegion(image, CAPE_BOX, 1).coverage, 0);
});

test('analyzeRegion() масштабирует проб на крупный файл', () => {
  // Тот же плащ, нарисованный в 8× размере: заполненность та же.
  const s = 8;
  const small = imageData(64, 32, (x, y) => (x < 22 && y < 17 ? [201, 125, 64, 255] : [0, 0, 0, 0]));
  const big = imageData(64 * s, 32 * s, (x, y) => (x < 22 * s && y < 17 * s ? [201, 125, 64, 255] : [0, 0, 0, 0]));
  const a = analyzeRegion(small, CAPE_BOX, 1).coverage;
  const b = analyzeRegion(big, CAPE_BOX, s).coverage;
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('analyzeRegion() не падает на дробном масштабе', () => {
  // 256×128 внутри кадра 46×22 — scale дробный, как у настоящих стеков.
  const k = 256 / 46;
  const image = imageData(256, 128, (x, y) => (x < 22 * k && y < 17 * k ? [201, 125, 64, 255] : [0, 0, 0, 0]));
  const r = analyzeRegion(image, CAPE_BOX, k);
  assert.ok(r.total > 0);
  assert.ok(r.coverage > 0.9, `хвост должен быть найден, покрытие ${r.coverage}`);
});

// ─── Вердикт ───

test('judgeElytra() переводит заполненность в уровень', () => {
  const full = atlasKind(64, 32);
  assert.equal(judgeElytra(full, 0.4).level, 'yes');
  assert.equal(judgeElytra(full, 0).level, 'none');
  assert.equal(judgeElytra(full, 0.01).level, 'none');
  assert.equal(judgeElytra(full, 0.05).level, 'weak');
});

test('judgeElytra() принимает результат atlasKind(), а не строку', () => {
  // Вердикт выводится из признака kind.hasElytraRoom, который живёт в
  // объекте. Строка вместо объекта молча разъезжалась: у неё
  // hasElytraRoom === undefined, а !undefined истинно — и ЛЮБОЙ плащ
  // получал «не помещаются». Проверяем на нераспознанном файле, где ответы
  // строковой и объектной версий расходятся.
  assert.equal(judgeElytra(atlasKind(100, 100), 0).level, 'unknown');
  assert.equal(judgeElytra(atlasKind(64, 32), 0.4).level, 'yes');
  assert.equal(judgeElytra(atlasKind(22, 17), 0).level, 'no-room');
});

test('judgeElytra() не путает «почти пусто» с «есть»', () => {
  // Пороги обязаны лежать в разрыве между реальными файлами. Замерено на
  // настоящих капах: крылья занимают 39.6–52.1% области, обычные плащи без
  // крыльев — 0–1.2%. Если файл новый и сдвинет эти числа, тест упадёт
  // первым, до того как порог начнёт врать пользователю в вердикте.
  assert.ok(ELYTRA_WEAK_MIN > 0.012,
    `слабый порог ${ELYTRA_WEAK_MIN} должен быть выше шума пустых файлов (1.2%)`);
  assert.ok(ELYTRA_WEAK_MIN < ELYTRA_YES_MIN, 'слабый порог обязан быть ниже порога «есть»');
  assert.ok(ELYTRA_YES_MIN < 0.396,
    `порог «есть» ${ELYTRA_YES_MIN} должен быть ниже самых бедных настоящих крыльев (39.6%)`);
});

test('judgeElytra() отличает «атлас не вмещает крылья» от «крыльев нет»', () => {
  const narrow = atlasKind(22, 17);
  assert.equal(narrow.hasElytraRoom, false);
  const v = judgeElytra(narrow, 0.9); // покрытие игнорируем: крыльям негде быть
  assert.equal(v.level, 'no-room');
  assert.equal(v.ok, false);
  assert.match(v.hint, /22×17/);
  // А полноразмерный атлас с той же нулевой заливкой — это «нет», не «негде».
  assert.equal(judgeElytra(atlasKind(64, 32), 0).level, 'none');
});

test('judgeElytra() для нераспознанного файла не врёт', () => {
  for (const kind of [atlasKind(100, 100), null, undefined]) {
    const v = judgeElytra(kind, 0);
    assert.equal(v.level, 'unknown');
    assert.equal(v.ok, false);
    assert.equal(v.coverage, 0);
  }
});

// ─── Прозрачность: крылья — это вырезка по альфе ───

test('pngTransparency() видит цвет-ключ tRNS у палитры', () => {
  // Палитра с tRNS: прозрачность есть, хотя в IHDR её не видно. Так записаны
  // 17 файлов на проде, и браузер их альфу отдаёт корректно — значит, сайт
  // обязан считать их прозрачными, иначе плащ покажется чёрным квадратом.
  const palette = [[201, 125, 64], [212, 90, 74], [0, 0, 0]];
  const painted = palettePng({
    width: 64, height: 32, palette, alpha: [255, 255, 0],
    paint: (x, y) => (x < 22 ? 0 : 1),
  });
  assert.equal(readPngHeader(bytes(painted)).colorType, 3);
  assert.equal(pngTransparency(bytes(painted)), 'trns');
  // Та же палитра без tRNS — прозрачности нет.
  const noAlpha = palettePng({
    width: 64, height: 32, palette,
    paint: (x, y) => (x < 22 ? 0 : 1),
  });
  assert.equal(pngTransparency(bytes(noAlpha)), 'none');
});

test('pngTransparency() у настоящего RGB-файла находит отсутствие альфы', () => {
  // Не «подставим colorType руками», а соберём настоящий файл без альфы —
  // ровно тот формат, из-за которого на проде два плаща получили «✓ крылья».
  const opaque = rgbPng(64, 32, (x, y) => (x < 22 ? [201, 125, 64] : [212, 90, 74]));
  assert.equal(readPngHeader(bytes(opaque)).colorType, 2);
  assert.equal(pngTransparency(bytes(opaque)), 'none');
  // Для сравнения RGBA-кап — прозрачный.
  assert.equal(pngTransparency(bytes(capeAtlas())), 'alpha');
});

test('judgeElytra() не выдаёт «крылья» файлу без альфа-канала', () => {
  const full = atlasKind(64, 32);
  // Заполненность 100%: у файла без альфы область крыльев залита ЦЕЛИКОМ,
  // всегда. Старая проверка читала это как «крылья нарисованы» и вешала
  // «✓ крылья» на плащ, у которого крыльев быть не может.
  const opaque = judgeElytra(full, 1, 'none');
  assert.equal(opaque.level, 'none');
  assert.equal(opaque.ok, false);
  assert.match(opaque.hint, /альфа-канал/);

  // С альфой тот же 100% — это честные крылья.
  assert.equal(judgeElytra(full, 1, 'alpha').level, 'yes');
  assert.equal(judgeElytra(full, 1, 'trns').level, 'yes');
  // Нет альфы — вердикт одинаков при любой заполненности: крыльев нет.
  assert.equal(judgeElytra(full, 0, 'none').level, 'none');
  // Атлас без места под крылья важнее альфы: там всё равно негде рисовать.
  assert.equal(judgeElytra(atlasKind(22, 17), 1, 'none').level, 'no-room');
});

// ─── Прямоугольники кадров ───

test('previewScale() ужимает широкий кадр и длинный стек', () => {
  // Кадр 256 влезает без ужатия.
  assert.equal(previewScale({ frameWidth: 256, frameHeight: 128, frames: 11 }), 1);
  // Кадр 2048 надо ужать до 256.
  assert.equal(previewScale({ frameWidth: 2048, frameHeight: 1024, frames: 8 }), 0.125);
  // Длинный стек ужимается по общей высоте, даже если кадр узкий.
  const many = previewScale({ frameWidth: 64, frameHeight: 32, frames: 300 });
  assert.ok(many < 1, '300 кадров не должны распухнуть');
  assert.ok(32 * 300 * many <= 8192, `итоговая высота ${32 * 300 * many} должна быть в пределах 8192`);
  // Результат всегда положителен.
  assert.ok(previewScale({ frameWidth: 1, frameHeight: 1, frames: 1 }) > 0);
});

test('frameRect() и regionRect() режут стек без щелей и перекрытий', () => {
  const g = { frameWidth: 256, frameHeight: 128, frames: 11 };
  const scale = 1;
  const atlas = 4; // 256×128 — атлас, растянутый вчетверо: 4 пикселя на тексель
  let expectedTop = 0;
  for (let i = 0; i < g.frames; i++) {
    const r = frameRect(g, scale, i);
    assert.equal(r.sx, 0);
    assert.equal(r.sy, expectedTop, `кадр ${i} должен начинаться сразу под предыдущим`);
    assert.equal(r.sw, 256);
    assert.equal(r.sh, 128);
    expectedTop += 128;
  }
  // Область крыльев — кусок кадра, сдвинутый и по x, и по y. Сдвиг по x
  // принципиален: крылья лежат в x∈[22,46), хвост в x∈[0,22), и без него
  // «элитры» показывали бы кусок хвоста.
  const el = regionRect(g, scale, atlas, 2, ELYTRA_BOUNDS);
  assert.equal(el.sx, 22 * atlas);
  assert.equal(el.sy, 2 * 128 + 0);
  assert.equal(el.sw, 24 * atlas);
  assert.equal(el.sh, 22 * atlas);
  // Хвост.
  const cape = regionRect(g, scale, atlas, 2, CAPE_BOUNDS);
  assert.equal(cape.sx, 0);
  assert.equal(cape.sy, 2 * 128);
  assert.equal(cape.sw, 22 * atlas);
  assert.equal(cape.sh, 17 * atlas);
  // Области не наезжают друг на друга даже в одном кадре.
  assert.equal(cape.sx + cape.sw, el.sx);
});

// Регрессия: область задана в сетке атласа 64×32, а не в пикселях файла. Для
// HD-капа (и для любого кадра шире 256 px) previewScale уходит ниже единицы, и
// если масштабировать область им, а не atlasScale, «элитры» сжимаются в пару
// пикселей — именно это и показывало мусорный лоскут вместо плаща.
test('regionRect() масштабирует область на масштаб атласа, а не на previewScale', () => {
  const g = { frameWidth: 2048, frameHeight: 1024, frames: 8 };
  const scale = previewScale(g);        // 0.125 — так сжимается сам кадр
  const atlas = 32 * scale;             // 4 — столько превью-пикселей на тексель
  assert.equal(scale, 0.125);

  const cape = regionRect(g, scale, atlas, 3, CAPE_BOUNDS);
  // До фикса тут было sw=3, sh=2: 22 * 0.125 и 17 * 0.125.
  assert.equal(cape.sw, 22 * atlas);
  assert.equal(cape.sh, 17 * atlas);
  assert.equal(cape.sx, 0);
  assert.equal(cape.sy, 3 * 1024 * 0.125);
  assert.ok(cape.sw > 1 && cape.sh > 1, 'область не должна схлопнуться в точку');

  const el = regionRect(g, scale, atlas, 3, ELYTRA_BOUNDS);
  assert.equal(el.sx, 22 * atlas);
  assert.equal(el.sw, 24 * atlas);
  assert.equal(el.sh, 22 * atlas);
  // Правый край области крыльев не выходит за пределы кадра.
  assert.ok(el.sx + el.sw <= g.frameWidth * scale);
});

test('regionRect() верно режет кадр 128×64', () => {
  const g = { frameWidth: 128, frameHeight: 64, frames: 4 };
  const scale = previewScale(g); // 1 — кадр уже влезает в 256
  const atlas = atlasKind(g.frameWidth, g.frameHeight).scale * scale;
  assert.equal(atlas, 2);

  const cape = regionRect(g, scale, atlas, 1, CAPE_BOUNDS);
  assert.equal(cape.sw, 44); // 22 * 2, а не 22
  assert.equal(cape.sh, 34); // 17 * 2, а не 17
  assert.equal(cape.sy, 64);
  assert.equal(cape.sx, 0);

  const el = regionRect(g, scale, atlas, 1, ELYTRA_BOUNDS);
  assert.equal(el.sx, 44);
  assert.equal(el.sw, 48);
  assert.equal(el.sh, 44);
});

test('доли превью (CAPE_FACE/ELYTRA_FACE) лежат внутри своих областей', () => {
  for (const [face, bounds] of [[CAPE_FACE, CAPE_BOUNDS], [ELYTRA_FACE, ELYTRA_BOUNDS]]) {
    assert.ok(face.x >= bounds.x && face.y >= bounds.y, 'грань должна быть внутри области');
    assert.ok(face.x + face.w <= bounds.x + bounds.w, 'грань не должна вылезать вправо');
    assert.ok(face.y + face.h <= bounds.y + bounds.h, 'грань не должна вылезать снизу');
    assert.ok(face.w > 0 && face.h > 0);
  }
  // Хвост и крыло — разные места атласа, а не один и тот же кусок.
  assert.notEqual(CAPE_FACE.x, ELYTRA_FACE.x);
});

test('frameRect() переживает уменьшенную превью-картинку', () => {
  const g = { frameWidth: 2048, frameHeight: 1024, frames: 8 };
  const scale = previewScale(g);
  for (let i = 0; i < g.frames; i++) {
    const r = frameRect(g, scale, i);
    assert.ok(r.sh >= 1, `кадр ${i} не должен схлопнуться в ноль`);
    assert.ok(r.sy + r.sh <= Math.ceil(g.frameHeight * g.frames * scale) + 1);
  }
});

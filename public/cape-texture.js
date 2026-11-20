// ─── Текстура плаща: атлас, стек кадров, крылья ───
//
// Все координаты — в сетке АТЛАСА 64×32. Именно к ней приводится любая
// текстура плаща, каким бы ни был размер файла:
//
//     canvas.width = 64 * scale;  canvas.height = 32 * scale;
//     ctx.drawImage(texture, 0, 0, texture.width, texture.height);
//
// scale выводится из пропорций файла (см. atlasKind). UV-боксы берутся из этой
// же нормализованной сетки, поэтому в пикселях файла они умножаются на scale:
//
//     хвост:  Pa(e,  0, 0, 10, 16, 1)
//     крылья: Pa(e, 22, 0, 10, 20, 2)
//
// Каждый бокс разворачивается в 6 граней, порядок — как в BoxGeometry:
// +X, -X, +Y, -Y, +Z, -Z.
//
// Главное следствие: хвост занимает x∈[0,22), крылья x∈[22,46). Области НЕ
// пересекаются. Значит, плащ без нарисованных крыльев в режиме элитр даёт
// невидимую модель — вместо крыльев пустота. Это и проверяет judgeElytra().

// Формат капа — чистый слой без DOM, общий с серверной проверкой загрузки.
import {
  readPngHeader, readPngTextChunks, pngTransparency, stackGeometry, atlasKind,
  analyzeFrame, judgeElytra, previewScale, frameRect, regionRect, normalizeBounds,
} from './cape-format.js';

// Переэкспорт целиком: страницы и тесты импортируют всё из cape-texture.js,
// и переименовывать импорты ради разделения файлов незачем.
export * from './cape-format.js';

// ─── Отрисовка превью (только браузер: нужен document) ───

function boundsSpan(bounds) {
  const b = normalizeBounds(bounds);
  const w = b.parts.reduce((s, p) => s + p.w, 0) + b.gap * (b.parts.length - 1);
  const h = b.parts.reduce((m, p) => Math.max(m, p.h), 0);
  return { ...b, w, h };
}

// Хвост (22×17) и крылья (24×22) — разные пропорции, поэтому канвас
// подгоняется под область, а не наоборот: иначе одна из превью
// растянулась бы с искажением.
export function previewCanvas(size, bounds) {
  const { w, h } = boundsSpan(bounds);
  const ratio = w / h;
  const canvas = document.createElement('canvas');
  if (ratio >= 1) {
    canvas.width = size;
    canvas.height = Math.max(1, Math.round(size / ratio));
  } else {
    canvas.height = size;
    canvas.width = Math.max(1, Math.round(size * ratio));
  }
  return canvas;
}

// Рисует область выбранного кадра прямо в существующий канвас. Для анимации
// это дешевле, чем создавать канвас на каждый кадр. Сглаживание выключено:
// плащи пиксельные, и bilinear превратил бы их в кашу.
export function paintFrame(ctx, texture, index, bounds) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  const b = normalizeBounds(bounds);

  // Один кусок: рисуем ровно как раньше, во весь канвас.
  if (b.parts.length === 1) {
    const src = regionRect(texture.geometry, texture.scale, texture.atlasScale, index, b.parts[0]);
    if (src.sw < 1 || src.sh < 1) return false;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(texture.canvas, src.sx, src.sy, src.sw, src.sh, 0, 0, width, height);
    return true;
  }

  const span = boundsSpan(b);
  if (span.w < 1 || span.h < 1) return false;
  // Один масштаб на все куски: при разном хвост и крыло разъедутся по пикселям,
  // а это ровно тот вид, который выдаёт себя за «сломанную текстуру».
  const s = Math.min(width / span.w, height / span.h);
  const offX = Math.round((width - span.w * s) / 2);
  const offY = Math.round((height - span.h * s) / 2);
  ctx.imageSmoothingEnabled = false;
  let x = offX;
  let drew = false;
  for (const part of b.parts) {
    const src = regionRect(texture.geometry, texture.scale, texture.atlasScale, index, part);
    if (src.sw < 1 || src.sh < 1) continue;
    const dw = Math.round(part.w * s);
    const dh = Math.round(part.h * s);
    ctx.drawImage(texture.canvas, src.sx, src.sy, src.sw, src.sh, x, offY, dw, dh);
    x += dw + Math.round(b.gap * s);
    drew = true;
  }
  return drew;
}

// Файл ещё читается. Тяжёлый стек (58 МП у «кирби») грузится по сети
// секундами, и до разбора контейнер карточки пустой — снаружи это выглядит
// как «плащ не показался». Заглушка только ставится, если в контейнере ещё
// нет холста: смонтированный вьюер или 2D-канвас не трогаем.
export function showLoading(container) {
  if (!container || container.querySelector('canvas')) return;
  const box = document.createElement('div');
  box.className = 'cape-loading';
  box.textContent = 'читаю текстуру…';
  container.replaceChildren(box);
}

// Файл не прочитался. Показываем честную надпись со ссылкой, а не сам файл:
// у стака из 65 кадров «каша всех кадров» в карточке — это ровно то, что
// пользователь описывает как «грузится как обычная текстурка».
export function showUnreadable(container, url) {
  const box = document.createElement('div');
  box.className = 'anim-preview-err';
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'открыть файл';
  box.append('не удалось прочитать PNG', ' · ', link);
  container.replaceChildren(box);
}

// Нарезает область в отдельный канвас — для плоского запасного варианта.
export function extractRegion(texture, bounds, index = 0, outWidth = 0) {
  const src = regionRect(texture.geometry, texture.scale, texture.atlasScale, index, bounds);
  const up = outWidth > 0 && src.sw > 0 ? outWidth / src.sw : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.sw * up));
  canvas.height = Math.max(1, Math.round(src.sh * up));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (src.sw >= 1 && src.sh >= 1) {
    ctx.drawImage(texture.canvas, src.sx, src.sy, src.sw, src.sh, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

// Проигрыватель кадров стека. Один канвас на всё время жизни карточки:
// каждый кадр перерисовывается на месте. Остановка обязательна при уходе
// карточки из зоны видимости, иначе setInterval живёт до перезагрузки.
export function createFramePlayer(fps = 12) {
  let timer = null;
  let ctx = null;
  let texture = null;
  let bounds = null;
  let frame = 0;

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function draw() {
    if (!ctx || !texture) return;
    if (texture.geometry.frames > 1) frame = (frame + 1) % texture.geometry.frames;
    paintFrame(ctx, texture, frame, bounds);
  }

  return {
    start(target, tex, region, from = 0) {
      stop();
      ctx = target;
      texture = tex;
      bounds = region;
      frame = from;
      paintFrame(ctx, texture, frame, bounds);
      if (texture && texture.geometry.frames > 1) {
        timer = setInterval(draw, Math.max(16, Math.round(1000 / fps)));
      }
    },
    // Смена режима на ходу: та же текстура, другая область.
    setBounds(region) {
      bounds = region;
      if (ctx && texture) paintFrame(ctx, texture, frame, bounds);
    },
    stop,
    get running() { return timer !== null; },
    get frame() { return frame; },
  };
}

// ─── Загрузка файла (только браузер: нужен createImageBitmap) ───

// Кадры, которые смотрим в анализе: первый, средний и последний. Анимация
// может рисовать крылья не в каждом кадре, поэтому берём максимум, а не
// содержимое кадра 0.
function sampleIndices(frames) {
  if (frames <= 1) return [0];
  if (frames <= 3) return Array.from({ length: frames }, (_, i) => i);
  return [0, Math.floor(frames / 2), frames - 1];
}

export async function loadTexture(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const header = readPngHeader(bytes);
  if (!header) throw new Error('не PNG или файл повреждён');

  const text = readPngTextChunks(bytes);
  const geometry = stackGeometry(header.width, header.height, text.Description);
  const kind = atlasKind(geometry.frameWidth, geometry.frameHeight);
  // Прозрачность смотрим в самом файле, а не догадываемся по покрытию:
  // у файла без альфы область крыльев залита целиком всегда.
  const transparency = pngTransparency(bytes, header.colorType);

  const scale = previewScale(geometry);
  const width = Math.max(1, Math.round(header.width * scale));
  const height = Math.max(1, Math.round(header.height * scale));

  // createImageBitmap умеет уменьшать при декодировании; браузеры, которые
  // не умеют, вернут полный размер — дальше всё равно рисуем сами.
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'pixelated' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();

  // Тексель атласа в уменьшенной картинке: kind.scale сжат тем же множителем.
  // Это и есть atlasScale — пикселей превью на тексель атласа 64×32.
  const atlasScale = kind.scale === null ? null : kind.scale * (width / geometry.frameWidth);
  const texel = atlasScale;

  let cape = null;
  let elytra = null;
  if (texel !== null) {
    for (const i of sampleIndices(geometry.frames)) {
      const rect = frameRect(geometry, scale, i);
      const safe = {
        sx: Math.min(rect.sx, Math.max(0, width - 1)),
        sy: Math.min(rect.sy, Math.max(0, height - 1)),
        sw: Math.max(1, Math.min(rect.sw, width - Math.min(rect.sx, Math.max(0, width - 1)))),
        sh: Math.max(1, Math.min(rect.sh, height - Math.min(rect.sy, Math.max(0, height - 1)))),
      };
      const a = analyzeFrame(ctx.getImageData(safe.sx, safe.sy, safe.sw, safe.sh), texel);
      if (!cape) { cape = a.cape; elytra = a.elytra; continue; }
      if (a.cape.coverage > cape.coverage) cape = a.cape;
      if (a.elytra.coverage > elytra.coverage) elytra = a.elytra;
    }
  }

  return {
    width: header.width,
    height: header.height,
    geometry,
    kind,
    transparency,
    warnings: geometry.warnings,
    canvas,
    scale,
    atlasScale,
    texel,
    cape: cape || { total: 0, opaque: 0, coverage: 0 },
    elytra: elytra || { total: 0, opaque: 0, coverage: 0 },
    verdict: judgeElytra(kind, elytra ? elytra.coverage : 0, transparency),
  };
}

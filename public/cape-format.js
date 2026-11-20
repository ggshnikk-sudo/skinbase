// Формат капа по байтам самого файла: заголовок PNG, геометрия стека кадров,
// вердикт по крыльям. Здесь НЕТ ничего браузерного — ни document, ни canvas, —
// и это не декоративно: тот же слой импортирует серверная проверка загрузки
// (functions/_lib/cape-check.js). Если бы правила «что считать плащом» жили
// только в браузере, сервер принимал бы файлы, которые превью потом не
// покажет, и vice versa.
//
// Кэш-бастры страниц это не ломает: cape-texture.js переэкспортирует всё
// отсюда, поэтому старые импорты продолжают работать.
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

export const ATLAS_W = 64;
export const ATLAS_H = 32;

export const CAPE_BOX = { u: 0, v: 0, w: 10, h: 16, d: 1 };
export const ELYTRA_BOX = { u: 22, v: 0, w: 10, h: 20, d: 2 };

// Габарит хвоста в сетке атласа — то, что натягивается на меш плаща.
export const CAPE_BOUNDS = { x: 0, y: 0, w: 22, h: 17 };
export const ELYTRA_BOUNDS = { x: 22, y: 0, w: 24, h: 22 };

// Развёртка целиком (CAPE_BOUNDS/ELYTRA_BOUNDS) — это лист граней, а не картинка:
// на карточке она читается плохо. Для плоского превью берём одну большую грань —
// лицо хвоста (тот самый рисунок, что видно за спиной) и широкую панель крыла.
// Грани совпадают с CAPE_BOX/ELYTRA_BOX: лицо хвоста — [1,1,11,17],
// широкая панель крыла — [36,2,46,22] (см. boxFaces).
export const CAPE_FACE = { x: 1, y: 1, w: 10, h: 16 };
// Панель для плоского превью. У CAPE это x∈[1,11) — хвост. У элитры наоборот:
// из двух широких панелей x∈[24,34) и x∈[36,46) настоящие плащи рисуют
// крылья в ПРАВОЙ, левая остаётся пустой. Проверено на 15 файлах с прод-хранилища
// (1024×512 и 2048×1024, все с verdict yes): в [36,2] покрытие 0.44–0.88, в
// [24,2] ровно 0. Взять левую — значит показать пустое превью.
export const ELYTRA_FACE = { x: 36, y: 2, w: 10, h: 20 };

// Пороги заполненности области крыльев. Калиброваны по реальным файлам:
// ванильные крылья и капы с прорисованными крыльями дают 39.6–52.1%,
// обычные капы без крыльев — 0–1.2%. 8% стоит в середине с зазором ×6.5 вниз
// и ×4.9 вверх.
export const ELYTRA_WEAK_MIN = 0.02;
export const ELYTRA_YES_MIN = 0.08;

// Шесть граней бокса в координатах атласа, в порядке +X, -X, +Y, -Y, +Z, -Z.
export function boxFaces({ u, v, w, h, d }) {
  return [
    [u + d, v, u + w + d, v + d],
    [u + w + d, v, u + 2 * w + d, v + d],
    [u, v + d, u + d, v + h + d],
    [u + d, v + d, u + w + d, v + h + d],
    [u + w + d, v + d, u + w + 2 * d, v + h + d],
    [u + w + 2 * d, v + d, u + 2 * w + 2 * d, v + h + d],
  ];
}

// Форма файла → масштаб приведения к атласу 64×32.
// Возможны ровно три пропорции: 64×32 (2:1, место под крылья есть),
// 22×22 по факту 22×17 (только хвост) и 46×22 (хвост + крылья).
export function atlasKind(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { kind: 'unsupported', scale: null, atlasWidth: null, hasElytraRoom: false, reason: 'пустой или дробный размер' };
  }
  if (width === 2 * height) {
    return { kind: 'full', scale: width / ATLAS_W, atlasWidth: ATLAS_W, hasElytraRoom: true, reason: null };
  }
  if (17 * width === 22 * height) {
    return { kind: 'cape-only', scale: width / 22, atlasWidth: 22, hasElytraRoom: false, reason: 'атлас 22×17 — места под крылья нет' };
  }
  if (11 * width === 23 * height) {
    return { kind: 'full', scale: width / 46, atlasWidth: 46, hasElytraRoom: true, reason: null };
  }
  return {
    kind: 'unsupported',
    scale: null,
    atlasWidth: null,
    hasElytraRoom: false,
    reason: `${width}×${height} не похож на текстуру плаща (нужно 64×32, 22×17 или 46×22)`,
  };
}

// ─── Разбор PNG ───

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

export function readPngHeader(bytes) {
  if (!isPng(bytes) || bytes.length < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return null;
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (type !== 'IHDR') return null;
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    // Глубина и тип цвета из IHDR: по ним видно, есть ли в файле прозрачность,
    // ещё до того как декодированы пиксели.
    bitDepth: bytes[24],
    colorType: bytes[25],
  };
}

// Откуда в файле берётся прозрачность: 'alpha' — свой канал, 'trns' — цвет-ключ
// у палитры/серого/RGB, 'none' — прозрачности нет вовсе.
//
// Это не украшение: крылья — это вырезка по прозрачности. У файла без неё
// область крыльев залита целиком, и любая проверка «есть ли крылья» по
// заполненности даёт 100% и рисует «✓ крылья» на плаще, у которого крыльев
// быть не может. На проде так ошибались два файла из 53.
export function pngTransparency(bytes, colorType = null) {
  const ct = colorType === null ? (readPngHeader(bytes) || {}).colorType : colorType;
  if (ct === 4 || ct === 6) return 'alpha';
  if (!isPng(bytes)) return 'none';

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  for (let guard = 0; guard < 256 && off + 8 <= bytes.length; guard++) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (type === 'tRNS') return 'trns';
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return 'none';
}

// Текстовые чанки до IDAT. Именно туда мод капов пишет «Stacked PNG: …».
// Сжатый zTXt игнорируем — как и сам мод.
export function readPngTextChunks(bytes) {
  const out = {};
  if (!isPng(bytes)) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  for (let guard = 0; guard < 256 && off + 8 <= bytes.length; guard++) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const start = off + 8;
    if (start + len + 4 > bytes.length) break;
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'tEXt') {
      const chunk = bytes.subarray(start, start + len);
      const sep = chunk.indexOf(0);
      if (sep > 0) out[latin1.decode(chunk.subarray(0, sep))] = latin1.decode(chunk.subarray(sep + 1));
    } else if (type === 'iTXt') {
      const chunk = bytes.subarray(start, start + len);
      const sep = chunk.indexOf(0);
      // keyword \0 compressionFlag compressionMethod language \0 translated \0 text
      // Искать язык надо с sep+3: на sep+2 лежит compressionMethod, и он тоже
      // равен нулю — поиск цеплял его и значение съезжало на байт с NUL в начале.
      if (sep > 0 && chunk[sep + 1] === 0) {
        const langEnd = chunk.indexOf(0, sep + 3);
        if (langEnd > 0) {
          const transEnd = chunk.indexOf(0, langEnd + 1);
          if (transEnd > 0) {
            out[latin1.decode(chunk.subarray(0, sep))] = utf8.decode(chunk.subarray(transEnd + 1));
          }
        }
      }
    }
    off = start + len + 4;
  }
  return out;
}

// Формат, который пишет мод капов: "Stacked PNG: 11 frames 256x128, order=down"
const STACKED_RE = /stacked\s+png\s*:\s*(\d+)\s+frames?\s+(\d+)\s*[x×]\s*(\d+)(?:\s*,\s*order\s*=\s*([a-z]+))?/i;

export function parseStackedDescription(text) {
  if (typeof text !== 'string') return null;
  const m = STACKED_RE.exec(text);
  if (!m) return null;
  return {
    frames: Number(m[1]),
    frameWidth: Number(m[2]),
    frameHeight: Number(m[3]),
    order: (m[4] || 'down').toLowerCase(),
  };
}

// Сколько кадров в файле. Заголовок авторитетен, только если он сходится с
// реальными размерами — иначе верим глазам и режем по пропорции плаща 2:1,
// как это делает мод капов.
export function stackGeometry(width, height, description) {
  const warnings = [];
  const declared = parseStackedDescription(description);

  if (declared) {
    if (declared.order !== 'down') warnings.push(`порядок кадров «${declared.order}» не поддерживается`);
    if (declared.frameWidth !== width || declared.frames * declared.frameHeight !== height) {
      warnings.push(`в заголовке ${declared.frames} × ${declared.frameWidth}×${declared.frameHeight}, а файл ${width}×${height}`);
    } else if (declared.order === 'down') {
      return { frames: declared.frames, frameWidth: width, frameHeight: declared.frameHeight, order: 'down', source: 'meta', warnings };
    }
  }

  const frameHeight = Math.round(width / 2);
  const frames = frameHeight > 0 ? Math.round(height / frameHeight) : 0;
  if (!frames || frames * frameHeight !== height) {
    return { frames: 1, frameWidth: width, frameHeight: height, order: 'down', source: 'single', warnings };
  }
  return {
    frames,
    frameWidth: width,
    frameHeight,
    order: 'down',
    source: frames > 1 ? 'guess' : 'single',
    warnings,
  };
}

// ─── Проверка крыльев ───

// Заполненность одной области атласа. image — ImageData-подобное ({data,width,height}):
// data с альфой в 4-м байте каждого пикселя. scale — сколько пикселей
// изображения приходится на один тексель атласа. Проб до 16 на тексель, не
// больше: на 520 текселях это ~8k выборок независимо от размера файла.
export function analyzeRegion(image, box, scale) {
  const { data, width, height } = image;
  const span = Math.max(1, Math.min(32, Math.round(scale)));
  const step = Math.max(1, Math.floor(span / 3));
  let total = 0;
  let opaque = 0;

  for (const [x0, y0, x1, y1] of boxFaces(box)) {
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        total++;
        const px0 = Math.floor(tx * scale);
        const py0 = Math.floor(ty * scale);
        let hit = false;
        for (let dy = 0; dy < span && !hit; dy += step) {
          for (let dx = 0; dx < span; dx += step) {
            const px = px0 + dx;
            const py = py0 + dy;
            if (px >= width || py >= height) continue;
            if (data[(py * width + px) * 4 + 3] > 0) { hit = true; break; }
          }
        }
        if (hit) opaque++;
      }
    }
  }
  return { total, opaque, coverage: total > 0 ? opaque / total : 0 };
}

// Заполненность хвоста и крыльев в одном кадре.
export function analyzeFrame(image, scale) {
  return {
    cape: analyzeRegion(image, CAPE_BOX, scale),
    elytra: analyzeRegion(image, ELYTRA_BOX, scale),
  };
}

// Итог проверки. Уровни: yes (крылья есть), weak (есть следы, но крыло
// прозрачное), none (крыльев нет), no-room (атлас не вмещает крылья),
// unknown (файл не распознан как текстура плаща).
//
// kind — результат atlasKind(), а не строка: признак «есть ли место под
// крылья» живёт именно в объекте.
//
// transparency — откуда в файле прозрачность (pngTransparency). Без неё
// вердикт по крыльям был бы фикцией: у файла RGB заполненность области
// крыльев всегда 100%, и сайт писал «✓ крылья» там, где крыльев нет.
export function judgeElytra(kind, coverage, transparency = 'unknown') {
  if (!kind || kind.kind === 'unsupported') {
    return { level: 'unknown', ok: false, coverage: 0, label: 'не распознан', hint: 'Файл не распознан как текстура плаща.' };
  }
  if (!kind.hasElytraRoom) {
    return {
      level: 'no-room',
      ok: false,
      coverage: 0,
      label: 'не помещаются',
      hint: 'Атлас 22×17 — под крылья места нет. Как элитры такой плащ покажет пустоту.',
    };
  }
  if (transparency === 'none') {
    return {
      level: 'none',
      ok: false,
      coverage: 0,
      label: 'нет',
      hint: 'В файле нет альфа-канала, крылья из него не вырезать: область залита целиком. Как элитры такой плащ покажет хвост без крыльев.',
    };
  }
  const pct = Math.round(coverage * 100);
  if (coverage >= ELYTRA_YES_MIN) {
    return { level: 'yes', ok: true, coverage, label: 'есть', hint: `Крылья нарисованы, занято ${pct}% области. Плащ годится и как элитры.` };
  }
  if (coverage >= ELYTRA_WEAK_MIN) {
    return { level: 'weak', ok: false, coverage, label: 'почти пусто', hint: `Область крыльев заполнена на ${pct}% — крыло получится почти прозрачным.` };
  }
  return {
    level: 'none',
    ok: false,
    coverage,
    label: 'нет',
    hint: 'Крылья не нарисованы: в режиме элитр вместо них пустота. Обычным плащом работает нормально.',
  };
}

// ─── Прямоугольники кадров (в пикселях уже уменьшенной превью-картинки) ───
//
// Здесь два разных масштаба, и путать их нельзя:
//
//   previewScale — сколько пикселей превью приходится на пиксель ФАЙЛА.
//                  Им двигается и режется сам кадр (frameRect).
//   atlasScale   — сколько пикселей превью приходится на тексель АТЛАСА 64×32.
//                  Им масштабируются области (bounds), потому что CAPE_BOUNDS
//                  и ELYTRA_BOUNDS заданы в сетке атласа, а не в пикселях файла.
//
// Раньше обе величины были одним previewScale, и это работало только для
// плаща 64×32: там previewScale === atlasScale === 1. У HD-плаща (и у любого
// кадра шире 256 px) previewScale уходит ниже единицы, и область 22×17
// схлопывалась в 3×2 пикселя вместо 88×68 — превью показывало мусорный
// лоскут вместо плаща. Поэтому масштабы разведены явно.

export function previewScale(geometry) {
  // Кадр шириной 256 — с запасом для 10×16 панели плаща; общая высота
  // ограничена, чтобы стек на 30 кадров не распухал до мегабайтов RGBA.
  return Math.min(1, 256 / geometry.frameWidth, 8192 / (geometry.frameHeight * geometry.frames));
}

export function frameRect(geometry, scale, index) {
  return {
    sx: 0,
    sy: Math.round(index * geometry.frameHeight * scale),
    sw: Math.round(geometry.frameWidth * scale),
    sh: Math.round(geometry.frameHeight * scale),
  };
}

export function regionRect(geometry, scale, atlasScale, index, bounds) {
  return {
    // Не 0: крылья лежат в x∈[22,46), и без сдвига по x «элитры» показывали
    // бы кусок хвоста.
    sx: Math.round(bounds.x * atlasScale),
    sy: Math.round(index * geometry.frameHeight * scale) + Math.round(bounds.y * atlasScale),
    sw: Math.round(bounds.w * atlasScale),
    sh: Math.round(bounds.h * atlasScale),
  };
}

export function normalizeBounds(bounds) {
  if (Array.isArray(bounds)) return { parts: bounds, gap: 0 };
  if (bounds && Array.isArray(bounds.parts)) return bounds;
  return { parts: [bounds], gap: 0 };
}

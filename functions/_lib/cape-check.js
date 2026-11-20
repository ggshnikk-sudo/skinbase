// Проверка загружаемого плаща тем же кодом, по которому потом рисуется
// превью. Смысл не в «ещё одной проверке», а в том, чтобы правила не разошлись:
// импортируется ровно тот модуль, который использует браузер, поэтому файл,
// принятый сервером, гарантированно распознаётся и превью.
//
// Проверяется всё, что видно из заголовка и первых чанков, без декодирования
// картинки: файл на 10 МБ читается из formData() один раз.

import {
  isPng, readPngHeader, readPngTextChunks, pngTransparency,
  stackGeometry, atlasKind,
} from '../../public/cape-format.js';

// Стек длиннее — это уже не плащ, а видео в disguise: превью режет его
// целиком в память браузера. Реальные капы на проде — до 65 кадров.
const MAX_FRAMES = 300;
// Жёсткий предел по площади одного кадра. 2048×1024 — самый крупный реальный
// кадр; держим запас и не даём залить 200-мегапиксельную картинку.
const MAX_FRAME_PIXELS = 4 * 1024 * 1024;

/**
 * Разбирает файл плаща и возвращает описание либо причину отказа.
 *
 * @param {Uint8Array} bytes
 * @param {{allowStack?: boolean}} [opts] allowStack=false — только одиночный
 *        кадр (обычный кап); true — стек кадров (анимированный).
 * @returns {{ok: true, header: object, geometry: object, kind: object,
 *            transparency: string, frames: number} | {ok: false, error: string}}
 */
export function checkCapePng(bytes, { allowStack = true } = {}) {
  if (!isPng(bytes)) {
    return { ok: false, error: 'Only PNG files are allowed' };
  }
  const header = readPngHeader(bytes);
  if (!header) {
    return { ok: false, error: 'Broken PNG: unreadable header' };
  }

  const text = readPngTextChunks(bytes);
  const geometry = stackGeometry(header.width, header.height, text.Description);
  const kind = atlasKind(geometry.frameWidth, geometry.frameHeight);
  if (kind.kind === 'unsupported') {
    return {
      ok: false,
      error: `Unsupported cape texture: frame ${geometry.frameWidth}x${geometry.frameHeight}`,
    };
  }
  if (!allowStack && geometry.frames > 1) {
    return {
      ok: false,
      error: `This is a ${geometry.frames}-frame cape stack — upload it as an animated cape`,
    };
  }
  if (geometry.frames > MAX_FRAMES) {
    return { ok: false, error: `Too many frames: ${geometry.frames} (max ${MAX_FRAMES})` };
  }
  if (geometry.frameWidth * geometry.frameHeight > MAX_FRAME_PIXELS) {
    return {
      ok: false,
      error: `Frame is too large: ${geometry.frameWidth}x${geometry.frameHeight}`,
    };
  }

  return {
    ok: true,
    header,
    geometry,
    kind,
    transparency: pngTransparency(bytes, header.colorType),
    frames: geometry.frames,
  };
}

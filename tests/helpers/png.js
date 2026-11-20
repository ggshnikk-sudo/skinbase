// Мини-генератор PNG для фикстур тестов. Нам нужен настоящий файл: модуль
// превью читает IHDR и tEXt/iTXt по байтам, и подсовывать ему рукописный
// заголовок значило бы тестировать не код, а свою же выдумку.
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// tEXt: keyword \0 value, всё в latin1.
function textChunk(keyword, value) {
  const k = Buffer.from(keyword, 'latin1');
  const v = Buffer.from(value, 'latin1');
  return chunk('tEXt', Buffer.concat([k, Buffer.from([0]), v]));
}

// iTXt: keyword \0 compressionFlag compressionMethod language \0 translated \0 text
// Сжатие всегда выключено — модуль его всё равно игнорирует.
function itxtChunk(keyword, value) {
  const k = Buffer.from(keyword, 'latin1');
  const v = Buffer.from(value, 'utf-8');
  return chunk('iTXt', Buffer.concat([
    k, Buffer.from([0]), Buffer.from([0, 0]),
    Buffer.from([0]), Buffer.from([0]), v,
  ]));
}

// zTXt: keyword \0 compressionMethod compressedData
function ztxtChunk(keyword, value) {
  const k = Buffer.from(keyword, 'latin1');
  return chunk('zTXt', Buffer.concat([
    k, Buffer.from([0]), Buffer.from([0]), deflateSync(Buffer.from(value, 'latin1')),
  ]));
}

// Низкоуровневый сборщик PNG: IHDR с ЛЮБЫМ типом цвета, произвольные чанки
// перед IDAT и растр, который пишет вызывающий. Через него собираются все
// фикстуры — и RGBA, и RGB без альфы, и палитра с tRNS.
function buildPng(width, height, colorType, bpp, pixelAt, beforeIdat = []) {
  const raw = Buffer.alloc((width * bpp + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = pixelAt(x, y);
      for (let i = 0; i < bpp; i++) raw[o++] = px[i];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE, chunk('IHDR', ihdr), ...beforeIdat,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function textChunks(extra) {
  return [
    ...Object.entries(extra.text || {}).map(([k, v]) => textChunk(k, v)),
    ...Object.entries(extra.itxt || {}).map(([k, v]) => itxtChunk(k, v)),
    ...Object.entries(extra.ztxt || {}).map(([k, v]) => ztxtChunk(k, v)),
  ];
}

/**
 * Кодирует RGBA-растр в настоящий PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>[number,number,number,number]} paint пиксель в RGBA 0..255
 * @param {{text?:Record<string,string>, itxt?:Record<string,string>, ztxt?:Record<string,string>}} extra
 */
export function encodePng(width, height, paint, extra = {}) {
  return buildPng(width, height, 6, 4, paint, textChunks(extra));
}

/**
 * RGB без альфа-канала (тип цвета 2). Прозрачности в таком файле нет ВООБЩЕ:
 * именно такие два файла из 53 лежат на проде, и сайт вешал на них
 * «✓ крылья», потому что область крыльев залита целиком.
 */
export function rgbPng(width, height, paint, extra = {}) {
  return buildPng(width, height, 2, 3, (x, y) => paint(x, y), textChunks(extra));
}

/**
 * Палитра (тип цвета 3) с альфой через tRNS — формат 17 файлов на проде.
 * Прозрачность в IHDR не видна, она лежит отдельным чанком, поэтому такой
 * файл обязан читаться как прозрачный, иначе плащ покажется чёрным квадратом.
 *
 * @param {{width:number,height:number,palette:number[][],alpha?:number[],
 *          paint:(x:number,y:number)=>number, extra?:object}} o
 */
export function palettePng({ width, height, palette, alpha, paint, extra = {} }) {
  const before = [
    chunk('PLTE', Buffer.from(palette.flat())),
    ...(alpha ? [chunk('tRNS', Buffer.from(alpha))] : []),
    ...textChunks(extra),
  ];
  return buildPng(width, height, 3, 1, paint, before);
}

// Границы, в которых реально рисуется хвост и крылья в атласе 64×32. Не совпадают
// с UV-боксами: UV раскладываются на 6 граней и перекрываются, а заполненность
// мы меряем по видимым прямоугольникам.
export const CAPE_RECT = { x: 0, y: 0, w: 22, h: 17 };
export const ELYTRA_RECT = { x: 22, y: 0, w: 24, h: 22 };

/**
 * Плащ 64×32: хвост заполнен, крылья — по доле cover (0..1 от площади).
 * Доля набирается построчно сверху вниз, чтобы доля была точной, а не случайной.
 */
export function capeAtlas(cover = 0) {
  const cape = { x: 0, y: 0, w: 22, h: 17 };
  const el = { x: 22, y: 0, w: 24, h: 22 };
  const elArea = el.w * el.h;
  let budget = Math.round(cover * elArea);
  return encodePng(64, 32, (x, y) => {
    const inCape = x >= cape.x && x < cape.x + cape.w && y < cape.y + cape.h;
    if (inCape) return [201, 125, 64, 255];
    const inEl = x >= el.x && x < el.x + el.w && y >= el.y && y < el.y + el.h;
    if (inEl && budget > 0) { budget--; return [212, 90, 74, 255]; }
    return [0, 0, 0, 0];
  });
}

/**
 * Стек кадров: кадры друг под другом, каждый шириной fw и пропорцией 2:1.
 * Кадр i красится функцией paint(i, x, y).
 */
export function stackedPng({ frames, frameWidth, frameHeight, description, itxt, painter }) {
  const height = frameHeight * frames;
  const paint = (x, y) => {
    const index = Math.floor(y / frameHeight);
    return (painter || (() => [201, 125, 64, 255]))(index, x, y - index * frameHeight);
  };
  const extra = {};
  if (description !== undefined) extra.text = { Description: description };
  if (itxt !== undefined) extra.itxt = { Description: itxt };
  return encodePng(frameWidth, height, paint, extra);
}

// Картинка в виде ImageData-подобного объекта, который понимает analyzeRegion.
export function imageData(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { data, width, height };
}

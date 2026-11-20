// Выбор хранилища файлов капа и уборка сохранённого файла.
//
// Ссылка лежит в колонке value. Это один из трёх видов:
//   https://files.catbox.moe/<name> — внешний хостинг CatBox;
//   https://<base>/<key>           — публичный объект S3-совместимого бакета;
//   kv:<name>                     — legacy-ключ из прежней версии, когда
//                                   файлы держались в Workers KV.
//
// Загрузка идёт в S3, если он настроен целиком, иначе в CatBox. CatBox
// остаётся рабочим запасным вариантом: снять S3 с настройки — и сайт вернётся
// на него одним изменением окружения.

import { catboxDelete, catboxFileName, catboxUpload } from './catbox.js';
import { isS3File, s3Configured, s3Delete, s3KeyFromUrl, s3Upload } from './s3.js';

/** Префикс объектов в бакете. */
const S3_KEY_PREFIX = 'capes';

/** Каким хранилищем сейчас заливаются капы: 's3' либо 'catbox'. */
export function capeStorageKind(env) {
  return s3Configured(env) ? 's3' : 'catbox';
}

/**
 * Ключ объекта под одну загрузку.
 *
 * Ключ всегда новый, а не производный от имени плаща: два одинаково названных
 * плаща не должны затирать друг друга, а перезалив не должен оставлять в D1
 * ссылку на файл, который тем временем сменился.
 */
function capeKey() {
  return `${S3_KEY_PREFIX}/${crypto.randomUUID()}.png`;
}

/**
 * Загрузить файл плаща и вернуть { value, storage } — что легло в D1.
 *
 * CatBox основной, S3-совместимый бакет резервный. Заведено так, потому что
 * CatBox умеет ответить «успехом» и не положить файл: пользователю без разницы,
 * какое хранилище виновато, — плащ должен загрузиться.
 *
 * Старые плащи при этом не трогаются: адрес файла лежит в колонке value у
 * каждой строки, поэтому старые ссылки отдаются со своих адресов, а новые
 * ложатся туда, где загрузка удалась. Переносить библиотеку не нужно.
 *
 * CatBox получает одну попытку вместо трёх: когда резерв есть, ждать три раза
 * провалившийся сервис — это задержка пользователя ради гарантированного
 * успеха по второму пути. Без S3 поведение прежнее, три попытки.
 *
 * Ответ хранилища сам по себе не считается успехом — каждый бэкенд проверяет
 * результат чтением (CatBox — телом, S3 — HEAD по публичной ссылке), и только
 * после этого ссылка доходит до вызывающего кода.
 */
export async function uploadCape(env, bytes, filename) {
  const haveFallback = s3Configured(env);

  let catboxError;
  try {
    const value = await catboxUpload(env, bytes, filename, {
      maxAttempts: haveFallback ? 1 : undefined
    });
    return { value, storage: 'catbox' };
  } catch (e) {
    catboxError = e;
  }

  if (!haveFallback) throw catboxError;

  console.warn('storage: catbox отказал, уходим в резерв:', catboxError.message);
  try {
    const value = await s3Upload(env, bytes, capeKey());
    return { value, storage: 's3' };
  } catch (e) {
    // Обе причины в одном сообщении: по логу видно, что чинить, а по одному
    // «ошибка загрузки» — нет.
    throw new Error(
      `оба хранилища отказали — catbox: ${catboxError.message}; s3: ${String((e && e.message) || e)}`
    );
  }
}

/**
 * Снести сохранённый файл капа.
 *
 * inUse — необязательный колбэк: получает ссылку и отвечает, ссылается ли на
 * неё что-то ещё. Нужен только для CatBox: он дедуплицирует по содержимому, и
 * два одинаково залитых капа могут делить один файл, так что удалять его можно
 * только когда он никому больше не нужен. У S3 такого нет — на каждую загрузку
 * свой ключ, — поэтому там проверка пропускается.
 *
 * Ошибки молча проглатываются: это уборка следов, и упасть тут значило бы
 * уронить весь запрос из-за того, что файл не удалился.
 */
export async function deleteStored(env, value, inUse = null) {
  if (!value) return;

  if (value.startsWith('kv:')) {
    if (env.SKINS_KV) {
      await env.SKINS_KV.delete(value.slice(3)).catch(() => {});
    }
    return;
  }

  if (isS3File(value, env)) {
    await s3Delete(env, s3KeyFromUrl(value, env));
    return;
  }

  if (inUse && (await inUse(value))) return;
  await catboxDelete(env, [catboxFileName(value)]).catch(() => {});
}
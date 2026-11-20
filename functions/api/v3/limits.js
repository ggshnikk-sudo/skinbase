// Лимиты загрузки — чтобы фронтенд не держал свою копию числа.
// Анонимный GET: значения публичные, иначе клиент не сможет подсказать
// человеку потолок до загрузки.
import { json } from '../../_lib/auth.js';
import { MAX_PNG_BYTES, MAX_PNG_MB } from '../../_lib/limits.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  return json({
    maxPngBytes: MAX_PNG_BYTES,
    maxPngMb: MAX_PNG_MB
  });
}

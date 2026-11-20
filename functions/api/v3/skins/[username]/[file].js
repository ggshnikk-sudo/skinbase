import { json } from '../../../../_lib/auth.js';
import { CACHE_MISSING, CACHE_MUTABLE, proxyTextureFile } from '../../../../_lib/catbox.js';

// Анонимная раздача капа по имени игрока:
//   GET /api/v3/skins/<username>/cape.png  → сам PNG (прокси с CatBox через /api/v3/skin-file)
//   GET /api/v3/skins/<username>/cape.json → {"cape": "<API url на файл>"}
//
// «Умное хеширование»: URL в cape.json привязан к КОНКРЕТНОМУ файлу (id), который
// меняется при смене капа. Клиенты/CSL кэшируют текстуру по URL из cape.json —
// смена капа меняет id → меняется URL → клиент качает новый файл.
//
// А вот сам cape.png по ИМЕНИ игрока под это правило НЕ подпадает: адрес
// после смены капа прежний. Он отдаётся как no-store (CACHE_MUTABLE), иначе
// edge Cloudflare продолжит отдавать старый плащ — сбросить edge-кэш из
// Worker нельзя. Раньше здесь стояло public, из-за чего игроки до часа
// видели старый кап после смены.
export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const file = params.file.toLowerCase();
  if (file !== 'cape.png' && file !== 'cape' && file !== 'cape.json') {
    return json({ error: 'Not found' }, 404);
  }
  const wantJson = file === 'cape.json';


  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE lower(username) = lower(?)'
  ).bind(params.username).first();

  if (!user) return json({ error: 'User not found' }, 404);

  const equipped = await env.DB.prepare(
    `SELECT ca.id AS cape_id, ca.value AS cape_value
     FROM equipped e
     LEFT JOIN skins ca ON e.cape_skin_id = ca.id
     WHERE e.user_id = ?`
  ).bind(user.id).first();

  if (!equipped?.cape_id) {
    return json({ error: 'Cape not equipped' }, 404);
  }

  if (wantJson) {
    // URL на файл через API: /api/v3/skin-file/<id>.png (сам файл — на CatBox)
    const url = new URL(request.url);
    const target = `${url.protocol}//${url.host}/api/v3/skin-file/${equipped.cape_id}.png`;
    const response = json({ cape: target });
    // Адрес изменяемый (привязан к имени, а не к id капа), поэтому и JSON
    // обязан быть no-store: без Cache-Control Cloudflare применяет эвристику
    // RFC 9111 и кладёт ответ в кэш, а сбросить edge-кэш из Worker нельзя.
    response.headers.set('Cache-Control', CACHE_MUTABLE);
    return response;
  }

  // cape.png → сразу PNG-байты (через прокси с CatBox), без редиректа — так
  // моды капов (Cape Provider и пр.) получают текстуру без лишних хопов.
  const fileResponse = await proxyTextureFile(equipped.cape_value, env, CACHE_MUTABLE);
  if (!fileResponse) {
    // Как и в skin-file/[id]: «файла нет» — почти всегда временно, поэтому
    // ответ не кэшируется и чинится сам, без сброса кэша зоны.
    const missing = json({ error: 'Cape file unavailable' }, 404);
    missing.headers.set('Cache-Control', CACHE_MISSING);
    return missing;
  }
  return fileResponse;
}
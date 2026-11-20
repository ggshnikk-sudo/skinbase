import { json } from '../../../../../_lib/auth.js';
import { CACHE_MISSING, CACHE_MUTABLE, proxyTextureFile } from '../../../../../_lib/catbox.js';

// Анонимная раздача анимированного капа по имени игрока (для модов капов):
//   GET /api/animated/v1/skins/<username>/cape.png  → Stacked PNG (прокси с CatBox)
//   GET /api/animated/v1/skins/<username>/cape.json → {"cape": <url>, "animated": true}
//
// Как резать стек и с каким темпом показывать кадры — решает сам мод клиента;
// здесь отдаём только сам файл и маркер типа «анимированный».
//
// ВНИМАНИЕ: этот адрес НЕ привязан к id капа — он привязан к имени игрока.
// Смена капа содержимое меняет, а адрес остаётся прежним, поэтому ссылка
// обязана отдаваться как no-store: иначе edge Cloudflare отдаёт старый плащ
// после смены (см. CACHE_MUTABLE). Постоянная ссылка с id — в cape.json
// и в /skin-file/<id>.png, её кэшировать безопасно.
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
    `SELECT ae.animated_skin_id AS cape_id, a.value AS cape_value
     FROM animated_equipped ae
     LEFT JOIN animated a ON ae.animated_skin_id = a.id
     WHERE ae.user_id = ?`
  ).bind(user.id).first();

  if (!equipped?.cape_id) {
    return json({ error: 'Animated cape not equipped' }, 404);
  }

  if (wantJson) {
    const url = new URL(request.url);
    const target = `${url.protocol}//${url.host}/api/animated/v1/skin-file/${equipped.cape_id}.png`;
    const response = json({
      cape: target,
      animated: true
    });
    // Адрес изменяемый (привязан к имени, а не к id капа), поэтому и JSON
    // обязан быть no-store: без Cache-Control Cloudflare применяет эвристику
    // RFC 9111 и кладёт ответ в кэш, а сбросить edge-кэш из Worker нельзя.
    response.headers.set('Cache-Control', CACHE_MUTABLE);
    return response;
  }

  // cape.png → сразу PNG-байты (прокси с CatBox), без редиректа
  const fileResponse = await proxyTextureFile(equipped.cape_value, env, CACHE_MUTABLE);
  if (!fileResponse) {
    // Как и в skin-file/[id]: «файла нет» — почти всегда временно, поэтому
    // ответ не кэшируется и чинится сам, без сброса кэша зоны.
    const missing = json({ error: 'Animated cape file unavailable' }, 404);
    missing.headers.set('Cache-Control', CACHE_MISSING);
    return missing;
  }
  return fileResponse;
}

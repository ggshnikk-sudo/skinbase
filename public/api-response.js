// Разбор ответа API без предположения, что это всегда JSON.
//
// Раньше оба фронтенда стояли на голом `await res.json()`. Ответ не-JSON —
// HTML-заглушка SPA-роутинга Cloudflare, текстовая страница 5xx, пустое тело —
// превращался в `Unexpected token '<'` и уезжал в тост дословно. Пользователь
// видел только сообщение движка браузера о разборе JSON: ни адреса, ни кода,
// ни причины, и диагностировать это было нечем.
//
// Здесь тело читается текстом и разбирается явно. JSON ведёт себя как раньше,
// всё остальное превращается в сообщение, по которому видно, куда смотреть.

// Сколько символов начала тела показывать. Много не нужно: в HTML-заглушке
// смыслового текста нет, а в текстовой ошибке Cloudflare он в первых строках.
const SNIPPET_LIMIT = 160;

// Ответы, которые прилетают от самой платформы, а не от приложения, и по коду
// неотличимы от пустых. Для них подсказка полезнее, чем тело: тело — это HTML
// на полстраницы, а суть сжата в одном предложении.
const HINTS = [
  // Файл не влезает в лимит платформы раньше, чем до него дойдёт наша проверка.
  { match: r => r.status === 413, hint: 'Cloudflare отклонил запрос по размеру тела' },
  // Необработанное исключение в Functions: прилетает текстом, не JSON.
  { match: r => /error code: 1101/.test(r.text), hint: 'необработанное исключение в Functions Cloudflare' },
  // Ничего не нашлось по маршруту — Cloudflare отдал index.html вместо ответа.
  { match: r => /^\s*<(!doctype|html)/i.test(r.text), hint: 'по этому адресу отдалась HTML-страница, а не ответ API' }
];

/** Тело ответа, годное для показа в сообщении: обрезанное и без хвоста мусора. */
function snippet(text, limit) {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Сообщение для ответа, который JSON не является. */
function nonJsonError(res, text, limit) {
  const contentType = res.headers.get('Content-Type') || 'не указан';
  const lines = [`сервер ответил не JSON: ${res.status}`, `адрес: ${res.url || '(неизвестен)'}`];
  const hint = HINTS.find(h => h.match({ status: res.status, text }));
  if (hint) lines.push(hint.hint);
  const body = snippet(text, limit);
  lines.push(body ? `типа ответа: ${contentType}, начало: ${body}` : `типа ответа: ${contentType}, тело пустое`);
  return new Error(lines.join(' · '));
}

/**
 * Тело ответа как объект, если это JSON, иначе — признак, что это не он.
 *
 * @returns {{json: true, data: any} | {json: false}}
 */
export function parseJsonBody(text) {
  // Пустое тело — не JSON, но и не ошибка платформы: так отвечает, например,
  // DELETE без содержимого. Отличать надо, а не путать с HTML.
  if (!text || !text.trim()) return { json: false };
  try {
    return { json: true, data: JSON.parse(text) };
  } catch {
    return { json: false };
  }
}

/**
 * Разбирает ответ API: возвращает разобранное тело или бросает Error с
 * причиной. Вызывающий получает либо данные, либо осмысленный текст.
 *
 * @param {Response} res
 * @param {{snippetLimit?: number}} [opts]
 */
export async function readApiResponse(res, { snippetLimit = SNIPPET_LIMIT } = {}) {
  const text = await res.text();
  const parsed = parseJsonBody(text);

  if (parsed.json) {
    // Прежнее поведение сохранено: чужой код ответа с телом-JSON отдаёт
    // приложенное приложением поле error, без него — общий текст.
    if (!res.ok) throw new Error(parsed.data?.error || 'Что-то пошло не так');
    return parsed.data;
  }

  // Успешный ответ без разбираемого тела — тоже мимо: вызывающий ждёт данные,
  // а отдать ему undefined значит уронить разбор где-то дальше по коду.
  throw nonJsonError(res, text, snippetLimit);
}
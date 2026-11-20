import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonBody, readApiResponse } from '../public/api-response.js';

// Главный симптом, ради которого модуль и написан: не-JSON больше не падает
// с «Unexpected token '<'» из движка браузера. Проверяем это буквально — если
// сообщение снова начнёт содержать этот текст, тест обязан redden.
function assertNotBrowserNoise(message) {
  assert.doesNotMatch(message, /Unexpected token/, `в сообщении остался шум браузера: ${message}`);
  assert.doesNotMatch(message, /JSON\.parse/, `в сообщении остался шум браузера: ${message}`);
}

/** Ответ-заглушка: конструктор Response не даёт задать свой url. */
function fakeResponse({ status = 200, body = '', contentType = '', url = 'https://s.gg/api/v3/upload' }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers(contentType ? { 'Content-Type': contentType } : {}),
    text: async () => body
  };
}

test('JSON-ответ разбирается и возвращается как есть', async () => {
  const res = new Response(JSON.stringify({ maxPngBytes: 20971520 }), {
    headers: { 'Content-Type': 'application/json' }
  });
  assert.deepEqual(await readApiResponse(res), { maxPngBytes: 20971520 });
});

test('ошибка приложения показывается полем error', async () => {
  const res = new Response(JSON.stringify({ error: 'Файл больше 20 МБ' }), { status: 413 });
  await assert.rejects(() => readApiResponse(res), /Файл больше 20 МБ/);
});

test('ошибка без поля error остаётся общей фразой', async () => {
  // Прежнее поведение сохранено: клиент не должен падать на нестандартном теле.
  const res = new Response(JSON.stringify({ nope: 1 }), { status: 500 });
  await assert.rejects(() => readApiResponse(res), /Что-то пошло не так/);
});

test('HTML-заглушка SPA вместо JSON больше не роняет разбор', async () => {
  // Точный регресс на сообщение пользователя. Cloudflare отдаёт index.html
  // с кодом 200, если по маршруту нет Function — раньше это давало
  // `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
  const res = new Response('<!DOCTYPE html>\n<html><head><title>SkinBase</title></head></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' }
  });
  const err = await readApiResponse(res, { snippetLimit: 40 }).catch(e => e);
  assert.ok(err instanceof Error, 'ожидалась ошибка, а не возврат');
  assertNotBrowserNoise(err.message);
  assert.match(err.message, /не JSON: 200/);
  assert.match(err.message, /HTML-страниц/);
  assert.match(err.message, /<!DOCTYPE html>/, 'начало тела помогает понять источник');
});

test('текстовая ошибка 1101 распознаётся как падение в Functions', async () => {
  const res = new Response('error code: 1101', { headers: { 'Content-Type': 'text/plain' } });
  const err = await readApiResponse(res).catch(e => e);
  assertNotBrowserNoise(err.message);
  assert.match(err.message, /1101/);
});

test('413 получает подсказку про размер', async () => {
  const res = new Response('<html><body>Request Entity Too Large</body></html>', {
    status: 413,
    headers: { 'Content-Type': 'text/html' }
  });
  const err = await readApiResponse(res).catch(e => e);
  assertNotBrowserNoise(err.message);
  assert.match(err.message, /размеру тела/);
});

test('пустое тело описывается словами, а не падает как битый JSON', async () => {
  const res = new Response(null, { status: 401, headers: { 'Content-Type': 'application/json' } });
  const err = await readApiResponse(res).catch(e => e);
  assertNotBrowserNoise(err.message);
  assert.match(err.message, /не JSON: 401/);
  assert.match(err.message, /тело пустое/);
});

test('успешный ответ без тела тоже считается ошибкой разбора', async () => {
  // Вызывающий ждёт данные. Отдать ему undefined значит уронить разбор позже,
  // в произвольном месте, — хуже, чем честно сказать сейчас.
  const res = new Response(null, { status: 200 });
  const err = await readApiResponse(res).catch(e => e);
  assertNotBrowserNoise(err.message);
  assert.match(err.message, /не JSON: 200/);
});

test('длинное HTML-тело обрезается и не засоряет сообщение', async () => {
  const res = fakeResponse({
    status: 404,
    body: `<!DOCTYPE html>${'<div>x</div>'.repeat(400)}`,
    contentType: 'text/html'
  });
  const err = await readApiResponse(res, { snippetLimit: 60 }).catch(e => e);
  assert.ok(err.message.length < 400, `сообщение разрослось: ${err.message.length} символов`);
  assert.match(err.message, /…/, 'обрезка помечена многоточием');
  assert.match(err.message, /адрес: https:\/\/s\.gg\/api\/v3\/upload/, 'адрес запроса должен быть в сообщении');
});

test('Content-Type отсутствует — это не повод замолчать', async () => {
  const res = fakeResponse({ status: 502, body: 'bad gateway', contentType: '' });
  const err = await readApiResponse(res).catch(e => e);
  assertNotBrowserNoise(err.message);
  assert.match(err.message, /не указан/);
});

test('parseJsonBody отличает пустое тело от не-JSON', () => {
  assert.deepEqual(parseJsonBody(''), { json: false });
  assert.deepEqual(parseJsonBody('   \n '), { json: false });
  assert.deepEqual(parseJsonBody('<html>'), { json: false });
  assert.deepEqual(parseJsonBody('{"a":1}'), { json: true, data: { a: 1 } });
  // Скалярный JSON — валидное тело, а не повод ронять разбор.
  assert.deepEqual(parseJsonBody('0'), { json: true, data: 0 });
  assert.deepEqual(parseJsonBody('null'), { json: true, data: null });
});
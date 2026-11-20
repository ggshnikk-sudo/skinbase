// Перехват прямого обращения к /app.js
// Легитимная подгрузка скрипта идёт с <script src="/app.js?v=16"> → Sec-Fetch-Dest: script
// Прямой заход хакера в адресной строке /app.js → Sec-Fetch-Dest: document (или другое)
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const fetchDest = (context.request.headers.get('Sec-Fetch-Dest') || '').toLowerCase();

  // Легитимная загрузка: скрипт грузится со страницы как <script src="/app.js?v=16">
  // В самом index.html всегда добавляется версия (?v=). Прямой заход — без query.
  const isLegitScript = fetchDest === 'script' || url.search !== '';

  // Если это легитимная загрузка как скрипт — отдаём реальный файл
  if (isLegitScript) {
    return await context.env.ASSETS.fetch(context.request);
  }

  // Прямой доступ — вежливо (нет, грубо) встречаем хакера
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>А вот и наш юный хакер 😏</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(circle at 50% 20%, #1a1033 0%, #0d0b1a 60%, #05040a 100%);
    font-family: 'Courier New', monospace;
    color: #e8e6ff;
    overflow: hidden;
  }
  .card {
    max-width: 640px;
    padding: 50px 60px;
    background: rgba(255,255,255,0.04);
    border: 2px solid #ff3d71;
    border-radius: 16px;
    box-shadow: 0 0 30px rgba(255,61,113,0.35), inset 0 0 40px rgba(255,61,113,0.08);
    text-align: center;
    position: relative;
  }
  .glitch {
    font-size: 42px;
    font-weight: bold;
    letter-spacing: 2px;
    color: #fff;
    text-shadow: 0 0 10px #ff3d71;
    margin-bottom: 25px;
    text-transform: uppercase;
  }
  .msg {
    font-size: 18px;
    line-height: 1.7;
    color: #c9c4ff;
    margin-bottom: 20px;
  }
  .msg b { color: #ff6b8f; }
  .msg .big {
    font-size: 28px;
    display: inline-block;
    color: #fff;
    letter-spacing: 3px;
    text-shadow: 0 0 20px #ff3d71, 0 0 40px #ff3d71;
    margin: 0 4px;
  }
  .hint {
    font-size: 14px;
    color: #6b6699;
    border-top: 1px dashed #3a3560;
    padding-top: 18px;
    margin-top: 10px;
  }
  .cursor { animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .scan {
    position: absolute; left: 0; right: 0;
    height: 120px; pointer-events: none;
    background: linear-gradient(180deg, transparent, rgba(255,61,113,0.06), transparent);
    animation: scan 4s linear infinite;
  }
  @keyframes scan { 0% { top: -120px; } 100% { top: 100%; } }
</style>
</head>
<body>
  <div class="scan"></div>
  <div class="card">
    <div class="glitch">А вот и наш юный хакер</div>
    <div class="msg">
      Ну что, <b>«хакер»</b>, нашёл чего искал?<br>
      Конечно нет, потому что ты <b>ничего не умеешь</b>.<br><br>
      Ты открыл адресную строку, набрал <b>/app.js</b><br>
      и наивно ждёшь, что тебе здесь что-то упадёт.<br>
      Ты что, реально думал, что исходники<br>
      <b>цыгане в интернете бесплатно раздают</b>?<br><br>
      Знаешь, в чём твоя проблема?<br>
      Ты даже <b>гуглом</b> пользоваться не умеешь.<br>
      Сидишь в своей каморке с девятого этажа,<br>
      вскрыл Ubuntu по туториалу с YouTube<br>
      и уже возомнил себя <b>Кевином Митником</b>.<br><br>
      Слушай сюда, <b>мамкин хакер</b>:<br>
      это не взлом, это <b>тыканье</b>.<br>
      Пацаны в подъезде и то ловчее wifi тырят.<br>
      Твой «взлом» — это как украсть велосипед<br>
      <b>и с гордостью об этом рассказать маме</b>.<br><br>
      Иди, родной, <b>нахуй</b>.<br>
      Найди себе нормальное занятие, ну или хотя бы<br>
      <b>научись гуглить</b>, прежде чем ломать чужое.<br>
      А лучше — пойди уроки сделай, <b>двоечник</b>.<br><br>
      Вот тебе весь «секретный код» твоего «взлома»:<br>
      <b class="big">тут.</b> <b class="big">пусто.</b><br>
      Вона оно твоё. Пользуйся. <span class="cursor">▊</span>
    </div>
    <div class="hint">IP  зафиксирован. Шутка. А может и нет, кто его знает 😉</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

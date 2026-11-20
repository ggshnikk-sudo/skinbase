const html = (content, title) => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — SkinBase API</title>
<link rel="icon" href="/favicon.png" type="image/png">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#16120e;--surface:#1f1a14;--border:#352d24;--text:#e8ddd0;--text-secondary:#a69685;--accent:#c97d40;--green:#3a9d66;--radius:10px;--font:system-ui,-apple-system,sans-serif}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.6;padding:40px 20px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:28px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px}
.sub{color:var(--text-secondary);font-size:14px;margin-bottom:28px}
.version-badge{display:inline-block;background:var(--green);color:#fff;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:16px}
.endpoint{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.endpoint h2{font-size:15px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.endpoint .method{display:inline-block;font-size:11px;padding:2px 7px;border-radius:5px;font-weight:700;text-transform:uppercase;letter-spacing:.3px}
.get{background:rgba(58,157,102,.15);color:#3a9d66}
.post{background:rgba(201,125,64,.15);color:var(--accent)}
.delete{background:rgba(212,90,74,.15);color:#d45a4a}
.endpoint .path{color:var(--accent);font-family:monospace;font-size:13px;margin-top:2px}
.endpoint .desc{color:var(--text-secondary);font-size:13px;margin:6px 0 10px}
.endpoint code{display:block;background:var(--bg);padding:10px 13px;border-radius:7px;font-size:12px;color:var(--text-secondary);overflow-x:auto;margin-top:6px;font-family:monospace;white-space:pre}
.notice{background:rgba(201,125,64,.08);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;font-size:13px;color:var(--text-secondary)}
.notice strong{color:var(--text)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="wrap">
<h1>✦ SkinBase · Анимированные капы</h1>
<p class="sub">Отдельная ветвь API animated — Stacked PNG (кадры друг под другом)</p>
<span class="version-badge">animated/v1 — первая версия анимированного API</span>
<div class="notice">
  <strong>Два плаща у игрока:</strong> обычный кап живёт в <a href="/api/v3/">/api/v3</a>,
  анимированный — здесь, в <code>/api/animated/v1</code>. Они не смешиваются: мод может держать
  оба слота и сам решает (в своём конфиге), какой кап показывать.
</div>
${content}
<p style="margin-top:24px;font-size:13px;color:var(--text-secondary)">
  <a href="/api/">← Все версии API</a> · <a href="/animated">Анимация на сайте</a>
</p>
</div>
</body>
</html>`;

const endpoints = [
  {
    method: 'GET',
    cls: 'get',
    path: '/api/animated/v1/equipped',
    desc: 'Все игроки с экипированным анимированным капом (отдельно от обычных).',
    resp: `{
  "count": 1,
  "users": [
    {
      "username": "GGSHNIKK",
      "equipped": {
        "animated": { "id": 1, "animated": true, "url": "/api/animated/v1/skin-file/1.png" }
      }
    }
  ]
}`
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/animated/v1/skins/{username}/cape.png',
    desc: 'Stacked PNG анимированного капа игрока. Анонимно, кэшируется CDN.',
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/animated/v1/skins/{username}/cape.json',
    desc: 'Маркер типа для модов: {cape, animated: true}. Кадры/темп стек режет сам мод.',
    resp: `{
  "cape": "https://.../api/animated/v1/skin-file/1.png",
  "animated": true
}`
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/animated/v1/skins',
    desc: 'Каталог всех анимированных капов (?search=...). Требует авторизации.',
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/animated/v1/skins/{id}',
    desc: 'Данные одного анимированного капа. Требует авторизации.',
  },
  {
    method: 'PUT',
    cls: 'post',
    path: '/api/animated/v1/skins/{id}',
    desc: 'Обновить название/теги анимированного капа. Требует авторизации.',
  },
  {
    method: 'DELETE',
    cls: 'delete',
    path: '/api/animated/v1/skins/{id}',
    desc: 'Удалить анимированный кап (вместе с файлом из хранилища). Требует авторизации.',
  },
  {
    method: 'POST',
    cls: 'post',
    path: '/api/animated/v1/upload',
    desc: 'Загрузка Stacked PNG (multipart: file — PNG до 2 МБ, name, tags). Требует авторизации.',
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/animated/v1/skin-file/{id}.png',
    desc: 'Раздача Stacked PNG по id (same-origin прокси).',
  },
  {
    method: 'GET/POST/DELETE',
    cls: 'get',
    path: '/api/animated/v1/equip',
    desc: 'Второй слот экипировки (анимированный): GET — текущий; POST {skin_id} — надеть; DELETE — снять. Требует авторизации.',
  },
];

export async function onRequest(context) {
  const items = endpoints.map(e => `
<div class="endpoint">
  <h2><span class="method ${e.cls}">${e.method}</span> <span style="font-weight:400;color:var(--text-secondary);font-size:13px">${e.path}</span></h2>
  <div class="desc">${e.desc}</div>
  ${e.resp ? `<code>${e.resp}</code>` : ''}
</div>`).join('');

  return new Response(html(items, 'Документация'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
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
<h1>✦ SkinBase API</h1>
<p class="sub">Публичное REST API — версия 3</p>
<span class="version-badge">v3 — актуальная версия</span>
<div class="notice">
  <strong>Обновление:</strong> система перешла на новый стандарт — только плащи, файлы хранятся
  в собственном хранилище. Старые версии API (v1, v2) сняты с эксплуатации.
</div>
${content}
<p style="margin-top:24px;font-size:13px;color:var(--text-secondary)">
  <a href="/api/">← Все версии API</a>
</p>
</div>
</body>
</html>`;

const endpoints = [
  {
    method: 'GET',
    cls: 'get',
    path: '/api/v3/equipped',
    desc: 'Все игроки с экипированными плащами одним запросом. Основной эндпоинт для CustomSkinLoader и игры.',
    resp: `{
  "count": 2,
  "users": [
    {
      "username": "GGSHNIKK",
      "equipped": {
        "cape": { "id": 12, "name": "Плащ", "url": "/api/v3/skin-file/12.png" }
      }
    }
  ]
}`
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/v3/skins/{username}/cape.png',
    desc: 'Файл экипированного плаща игрока (PNG). Анонимный доступ, кэшируется CDN.',
  },
  {
    method: 'POST',
    cls: 'post',
    path: '/api/v3/upload',
    desc: 'Загрузка плаща (multipart/form-data: file — PNG до 2 МБ, name, tags). Требует авторизации (cookie __session).',
    resp: `{
  "skin": {
    "id": 13,
    "name": "Мой плащ",
    "category": "cape",
    "tags": "красный, огонь",
    "url": "/api/v3/skin-file/13.png"
  }
}`
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/v3/skins',
    desc: 'Список плащей текущего пользователя (?search=...). Требует авторизации.',
  },
  {
    method: 'PUT',
    cls: 'post',
    path: '/api/v3/skins/{id}',
    desc: 'Обновить название/теги плаща. Требует авторизации.',
  },
  {
    method: 'DELETE',
    cls: 'delete',
    path: '/api/v3/skins/{id}',
    desc: 'Удалить плащ (вместе с файлом из хранилища). Требует авторизации.',
  },
  {
    method: 'GET/POST/DELETE',
    cls: 'get',
    path: '/api/v3/equip',
    desc: 'GET — текущая экипировка; POST {skin_id} — надеть плащ; DELETE — снять. Требует авторизации.',
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/v3/backup',
    desc: 'Статус бэкапа удалённых при миграции скинов: { exists, count, download_url }. Требует авторизации.',
  },
  {
    method: 'GET',
    cls: 'get',
    path: '/api/v3/backup/download',
    desc: 'Скачать бэкап JSON-файлом; после выдачи бэкап удаляется. Требует авторизации.',
  },
  {
    method: 'POST',
    cls: 'post',
    path: '/api/v3/backup/decline',
    desc: 'Отказаться от бэкапа (удаляет его). Требует авторизации.',
  },
  {
    method: 'GET/POST',
    cls: 'get',
    path: '/api/v3/tokens',
    desc: 'API-токены: GET — список; POST {name} — создать (токен показывается один раз). Требует авторизации.',
  },
  {
    method: 'DELETE',
    cls: 'delete',
    path: '/api/v3/tokens/{id}',
    desc: 'Отозвать API-токен. Требует авторизации.',
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

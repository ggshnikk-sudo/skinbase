import { obsoletePage } from '../_lib/obsolete.js';

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SkinBase API — Версии</title>
<link rel="icon" href="/favicon.png" type="image/png">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#16120e;--surface:#1f1a14;--border:#352d24;--text:#e8ddd0;--text-secondary:#a69685;--accent:#c97d40;--green:#3a9d66;--red:#d45a4a;--radius:10px;--font:system-ui,-apple-system,sans-serif}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.6;padding:40px 20px}
.wrap{max-width:640px;margin:0 auto}
h1{font-size:28px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px}
.sub{color:var(--text-secondary);font-size:14px;margin-bottom:32px}
.version{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:12px}
.version h2{font-size:16px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.version .badge{display:inline-block;color:#fff;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700}
.version .active{background:var(--green)}
.version .gone{background:var(--red)}
.version p{color:var(--text-secondary);font-size:13px;margin-top:6px}
.version a{color:var(--accent);text-decoration:none}
.version a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="wrap">
<h1>✦ SkinBase API</h1>
<p class="sub">Выберите версию API</p>
<div class="version">
  <h2><span class="badge active">v3</span> <a href="/api/v3/">→ Документация</a></h2>
  <p>Актуальная версия. Только плащи, файлы хранятся в собственном хранилище. Эндпоинты: <code>/api/v3/list</code>, <code>/api/v3/equipped</code>, <code>/api/v3/upload</code></p>
</div>
<div class="version">
  <h2><span class="badge gone">v2</span> <a href="/api/v2/">→ Страница</a></h2>
  <p>Снята с эксплуатации после масштабного обновления — формат несовместим с новыми стандартами</p>
</div>
<div class="version">
  <h2><span class="badge gone">v1</span> <a href="/api/v1/">→ Страница</a></h2>
  <p>Снята с эксплуатации после масштабного обновления — формат несовместим с новыми стандартами</p>
</div>
</div>
</body>
</html>`;

export async function onRequest() {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

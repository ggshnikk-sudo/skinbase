// Снятые с эксплуатации версии API (v1, v2).
// После масштабного обновления на v3 старые эндпоинты больше не работают:
// их формат несовместим с новыми стандартами (только плащи, файлы в KV).

import { json } from './auth.js';

export function obsoleteJson() {
  return json(
    {
      error: 'Not Found',
      message: 'Этот эндпоинт API снят с эксплуатации. Система получила масштабное обновление, и данный формат API больше не поддерживается из-за несовместимости с новыми стандартами. Используйте /api/v3/.'
    },
    404
  );
}

export function obsoletePage(version) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API v${version} — снят с эксплуатации</title>
<link rel="icon" href="/favicon.png" type="image/png">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#16120e;--surface:#1f1a14;--border:#352d24;--text:#e8ddd0;--text-secondary:#a69685;--accent:#c97d40;--green:#3a9d66;--red:#d45a4a;--radius:10px;--font:system-ui,-apple-system,sans-serif}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.6;padding:40px 20px}
.wrap{max-width:680px;margin:0 auto}
.badge{display:inline-block;background:var(--red);color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:16px}
h1{font-size:28px;font-weight:700;letter-spacing:-.3px;margin-bottom:8px}
.sub{color:var(--text-secondary);font-size:14px;margin-bottom:28px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:16px}
.card h2{font-size:15px;font-weight:600;margin-bottom:8px}
.card p{color:var(--text-secondary);font-size:13px}
.card code{background:var(--bg);padding:2px 7px;border-radius:5px;font-size:12px;color:var(--accent);font-family:monospace}
a.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;margin-top:12px}
a.btn:hover{opacity:.9}
.version-list{list-style:none;margin-top:10px}
.version-list li{font-size:13px;color:var(--text-secondary);margin-bottom:6px}
.version-list .v3{color:var(--green);font-weight:600}
</style>
</head>
<body>
<div class="wrap">
<span class="badge">API v${version} — снят с эксплуатации</span>
<h1>✦ SkinBase API</h1>
<p class="sub">Система получила масштабное обновление</p>
<div class="card">
  <h2>Что произошло</h2>
  <p>
    SkinBase перешёл на новый стандарт: хранятся только плащи, файлы раздаются напрямую
    из собственного хранилища. Старый формат API (v${version}) несовместим с новыми
    стандартами и больше не поддерживается — все эндпоинты возвращают <code>404</code>.
  </p>
</div>
<div class="card">
  <h2>Что делать</h2>
  <ul class="version-list">
    <li class="v3">✓ Используйте актуальную версию API v3</li>
    <li>Старые скины (персонажи, элитры) были удалены — бэкап можно скачать в личном кабинете</li>
    <li>Плащи продолжают работать как раньше</li>
  </ul>
  <a class="btn" href="/api/v3/">Перейти к API v3</a>
</div>
</div>
</body>
</html>`;
}

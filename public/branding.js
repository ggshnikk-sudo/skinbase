(function () {
  'use strict';

  // === Конфигурация ===
  // Укажите URL вашего branding-сервиса (Worker + D1/R2).
  // GET  CONFIG_URL       -> возвращает JSON-конфиг (публично)
  // POST ADMIN_URL        -> сохраняет конфиг (только GGSHNIKK, проверка на бэкенде обязательна)
  // По умолчанию - same-origin пути (удобно, если добавите роут на этот домен).
  var BRANDING = window.SKINBASE_BRANDING || {};
  var CONFIG_URL = BRANDING.configUrl || '/api/branding/config';
  var ADMIN_URL = BRANDING.adminUrl || '/api/branding/config';
  var CACHE_KEY = 'sb_branding_config_v1';
  var ADMIN_USER = 'ggshnikk';

  var state = {
    config: null,
    user: null,
    panelOpen: false,
    saveTimer: null,
  };

  function log() {
    if (BRANDING.debug) console.log.apply(console, ['[branding]'].concat([].slice.call(arguments)));
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeCache(cfg) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg || null)); } catch (e) {}
  }

  function defaultConfig() {
    return { version: 0, logoUrl: '', iconUrl: '', faviconUrl: '', themeCss: '', brandName: '' };
  }

  function normalizeConfig(cfg) {
    var c = Object.assign(defaultConfig(), cfg || {});
    if (!c.logoUrl && c.logo) c.logoUrl = c.logo;
    if (!c.iconUrl && c.icon) c.iconUrl = c.icon;
    if (!c.faviconUrl && c.favicon) c.faviconUrl = c.favicon;
    if (!c.themeCss && c.css) c.themeCss = c.css;
    if (!c.themeCss && c.customCss) c.themeCss = c.customCss;
    if (!c.themeCssUrl && c.cssUrl) c.themeCssUrl = c.cssUrl;
    return c;
  }

  function ensureStyleEl() {
    var el = document.getElementById('sb-branding-theme');
    if (!el) {
      el = document.createElement('style');
      el.id = 'sb-branding-theme';
      document.head.appendChild(el);
    }
    return el;
  }

  function ensureCssLinkEl() {
    var el = document.getElementById('sb-branding-theme-link');
    if (!el) {
      el = document.createElement('link');
      el.id = 'sb-branding-theme-link';
      el.rel = 'stylesheet';
      document.head.appendChild(el);
    }
    return el;
  }

  function applyImages(cfg) {
    cfg = normalizeConfig(cfg || state.config || defaultConfig());
    var logo = cfg.logoUrl || cfg.iconUrl || '';
    if (logo) {
      $$('.brand-icon, .auth-brand, img[src="skinbase-icon.png"], img[src="/skinbase-icon.png"], img[src$="/skinbase-icon.png"]').forEach(function (img) {
        if (img.getAttribute('data-branding-original-src') == null) {
          img.setAttribute('data-branding-original-src', img.getAttribute('src') || '');
        }
        if (img.getAttribute('src') !== logo) img.setAttribute('src', logo);
      });
    } else {
      $$('.brand-icon, .auth-brand').forEach(function (img) {
        var orig = img.getAttribute('data-branding-original-src');
        if (orig && img.getAttribute('src') !== orig) img.setAttribute('src', orig);
      });
    }
  }

  function applyConfig(cfg) {
    cfg = normalizeConfig(cfg);
    state.config = cfg;

    applyImages(cfg);

    var fav = cfg.faviconUrl || cfg.iconUrl || '';
    if (fav) {
      $$('link[rel~="icon"]').forEach(function (l) { l.href = fav; });
      if (!$$('link[rel~="icon"]').length) {
        var link = document.createElement('link');
        link.rel = 'icon';
        link.href = fav;
        document.head.appendChild(link);
      }
    }

    if (cfg.brandName) {
      $$('.brand-text').forEach(function (el) { el.textContent = cfg.brandName; });
      var h1 = $('.auth-header h1');
      if (h1) h1.textContent = cfg.brandName;
      try {
        if (document.title.indexOf('·') !== -1) {
          document.title = cfg.brandName + ' ' + document.title.substring(document.title.indexOf('·'));
        } else {
          document.title = cfg.brandName;
        }
      } catch(e) {}
    }

    if (cfg.themeCssUrl) {
      var link = ensureCssLinkEl();
      var url = cfg.themeCssUrl + (cfg.themeCssUrl.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(cfg.version || Date.now());
      if (link.href !== url) link.href = url;
    }
    if (cfg.themeCss) {
      ensureStyleEl().textContent = cfg.themeCss;
    } else if (!cfg.themeCssUrl) {
      var s = document.getElementById('sb-branding-theme');
      if (s) s.textContent = '';
    }

    document.documentElement.setAttribute('data-branding-version', String(cfg.version || ''));
    log('applied', cfg.version);
  }

  function fetchConfig() {
    var url = CONFIG_URL + (CONFIG_URL.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    return fetch(url, { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (cfg) {
        cfg = normalizeConfig(cfg && cfg.config ? cfg.config : cfg);
        if (!state.config || String(cfg.version) !== String(state.config.version)) {
          writeCache(cfg);
          applyConfig(cfg);
        } else if (document.readyState !== 'loading') {
          // Версия та же, но элементы могли появиться позже первого применения.
          try { applyImages(state.config); } catch (e) {}
        }
        return cfg;
      })
      .catch(function (e) { log('fetch config failed', e); return null; });
  }

  function isAdminUser(user) {
    if (!user) return false;
    if (user.isSuperAdmin || user.isAdmin || user.canDelete) return true;
    var name = (user.username || user.name || user.login || '').toLowerCase();
    return name === ADMIN_USER;
  }

  function setUser(user) {
    var prev = state.user && (state.user.username || state.user.name || '').toLowerCase();
    state.user = user || null;
    var now = state.user && (state.user.username || state.user.name || '').toLowerCase();
    if (prev !== now) {
      log('user changed', now);
      updateAdminUi();
    }
  }

  function detectUserFromDom() {
    var el = $('#nav-username');
    if (el && el.textContent && el.textContent.trim()) {
      return { username: el.textContent.trim() };
    }
    return null;
  }

  function extractUserFromResponse(url, data) {
    try {
      if (!data) return null;
      if (data.user && data.user.username) return data.user;
      if (data.username) return { username: data.username };
    } catch (e) {}
    return null;
  }

  function installFetchHook() {
    if (!window.fetch || window.fetch.__brandingHooked) return;
    var orig = window.fetch;
    var wrapped = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      return orig.apply(this, arguments).then(function (res) {
        try {
          if (url.indexOf('/api/v3/me') !== -1 || url.indexOf('/api/v3/login') !== -1 || url.indexOf('/api/v3/register') !== -1) {
            var clone = res.clone();
            clone.json().then(function (data) {
              var u = extractUserFromResponse(url, data);
              if (u) setUser(u);
            }).catch(function () {});
          }
          if (url.indexOf('/api/v3/logout') !== -1) setUser(null);
        } catch (e) {}
        return res;
      });
    };
    wrapped.__brandingHooked = true;
    window.fetch = wrapped;
  }

  function injectStyles() {
    if (document.getElementById('sb-branding-admin-css')) return;
    var css = '' +
      '.sb-admin-fab{position:fixed;right:16px;bottom:16px;z-index:9999;background:#c97d40;color:#fff;border:none;border-radius:999px;padding:10px 14px;font:600 13px/1.2 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)}' +
      '.sb-admin-fab:hover{filter:brightness(1.08)}' +
      '.sb-admin-modal{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center}' +
      '.sb-admin-modal.hidden{display:none}' +
      '.sb-admin-overlay{position:absolute;inset:0;background:rgba(0,0,0,.55)}' +
      '.sb-admin-card{position:relative;width:min(720px,94vw);max-height:90vh;overflow:auto;background:#1f1a14;color:#e8ddd0;border:1px solid #352d24;border-radius:12px;padding:18px;font:14px/1.45 Inter,system-ui,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,.5)}' +
      '.sb-admin-card h3{margin:0 0 12px;font-size:18px}' +
      '.sb-admin-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
      '.sb-admin-card label{display:block;font-size:12px;color:#a69685;margin:8px 0 4px}' +
      '.sb-admin-card input[type=text],.sb-admin-card textarea{width:100%;background:#16120e;color:#e8ddd0;border:1px solid #352d24;border-radius:8px;padding:8px 10px;font:13px/1.4 ui-monospace,monospace}' +
      '.sb-admin-card textarea{min-height:220px;resize:vertical;font-size:12px}' +
      '.sb-admin-row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}' +
      '.sb-admin-btn{background:#c97d40;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600}' +
      '.sb-admin-btn.sec{background:#2a231c;color:#e8ddd0;border:1px solid #352d24}' +
      '.sb-admin-btn.danger{background:#d45a4a}' +
      '.sb-admin-status{font-size:12px;color:#a69685;margin-left:auto}' +
      '.sb-admin-preview{display:flex;gap:12px;align-items:center;margin:8px 0}' +
      '.sb-admin-preview img{width:48px;height:48px;object-fit:contain;background:#16120e;border:1px solid #352d24;border-radius:8px;image-rendering:pixelated}' +
      '@media(max-width:640px){.sb-admin-grid{grid-template-columns:1fr}}';
    var el = document.createElement('style');
    el.id = 'sb-branding-admin-css';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function ensureAdminDom() {
    if ($('#sb-admin-fab')) return;
    injectStyles();
    var fab = document.createElement('button');
    fab.id = 'sb-admin-fab';
    fab.className = 'sb-admin-fab';
    fab.type = 'button';
    fab.textContent = '⚙ Брендинг';
    fab.style.display = 'none';
    fab.addEventListener('click', openPanel);
    document.body.appendChild(fab);

    var modal = document.createElement('div');
    modal.id = 'sb-admin-modal';
    modal.className = 'sb-admin-modal hidden';
    modal.innerHTML = '' +
      '<div class="sb-admin-overlay"></div>' +
      '<div class="sb-admin-card" role="dialog" aria-label="Брендинг">' +
      '  <h3>Брендинг / Тема (GGSHNIKK)</h3>' +
      '  <div class="sb-admin-grid">' +
      '    <div>' +
      '      <label>URL логотипа (шапка/авторизация)</label>' +
      '      <input type="text" id="sb-a-logo" placeholder="https://.../logo.png или data:image/...">' +
      '      <label>Загрузить файл логотипа</label>' +
      '      <input type="file" id="sb-a-logo-file" accept="image/*">' +
      '      <div class="sb-admin-preview"><img id="sb-a-logo-prev" alt=""><span style="font-size:12px;color:#a69685">превью</span></div>' +
      '    </div>' +
      '    <div>' +
      '      <label>URL иконки/фавикона</label>' +
      '      <input type="text" id="sb-a-icon" placeholder="https://.../icon.png или data:image/...">' +
      '      <label>Загрузить файл иконки</label>' +
      '      <input type="file" id="sb-a-icon-file" accept="image/*">' +
      '      <div class="sb-admin-preview"><img id="sb-a-icon-prev" alt=""><span style="font-size:12px;color:#a69685">превью</span></div>' +
      '    </div>' +
      '  </div>' +
      '  <label>Название бренда (необязательно)</label>' +
      '  <input type="text" id="sb-a-name" placeholder="SkinBase">' +
      '  <label>Кастомный CSS темы (фон, виджеты, сайт, плащи и т.д.)</label>' +
      '  <textarea id="sb-a-css" spellcheck="false" placeholder=":root { --bg: #101010; --accent: #ff6600; }\nbody { background: ...; }"></textarea>' +
      '  <div class="sb-admin-row">' +
      '    <button type="button" class="sb-admin-btn" id="sb-a-save">Сохранить и опубликовать</button>' +
      '    <button type="button" class="sb-admin-btn sec" id="sb-a-apply">Применить локально</button>' +
      '    <button type="button" class="sb-admin-btn danger" id="sb-a-reset">Сбросить дефолт</button>' +
      '    <a class="sb-admin-btn sec" href="/branding-admin.html" style="text-decoration:none;display:inline-block">Полная админ-панель</a>' +
      '    <button type="button" class="sb-admin-btn sec" id="sb-a-close">Закрыть</button>' +
      '    <span class="sb-admin-status" id="sb-a-status"></span>' +
      '  </div>' +
      '  <div style="margin-top:10px;font-size:11px;color:#736659">POST ' + ADMIN_URL + ' (JSON {config}). Бэкенд обязан проверить, что действует GGSHNIKK. Браузер и клиент подхватят конфиг при загрузке/обновлении.</div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.querySelector('.sb-admin-overlay').addEventListener('click', closePanel);
    $('#sb-a-close').addEventListener('click', closePanel);
    $('#sb-a-save').addEventListener('click', saveConfig);
    $('#sb-a-apply').addEventListener('click', function () { applyConfig(readFormConfig()); setStatus('Применено локально'); });
    $('#sb-a-reset').addEventListener('click', resetConfig);
    bindFileInput('#sb-a-logo-file', '#sb-a-logo', '#sb-a-logo-prev');
    bindFileInput('#sb-a-icon-file', '#sb-a-icon', '#sb-a-icon-prev');
  }

  function bindFileInput(fileSel, textSel, prevSel) {
    var f = $(fileSel), t = $(textSel), p = $(prevSel);
    if (!f) return;
    f.addEventListener('change', function () {
      var file = f.files && f.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        t.value = String(e.target.result || '');
        if (p) p.src = t.value;
      };
      reader.readAsDataURL(file);
    });
    t.addEventListener('input', function () { if (p) p.src = t.value; });
  }

  function fillFormFromConfig(cfg) {
    cfg = normalizeConfig(cfg || state.config || defaultConfig());
    if ($('#sb-a-logo')) $('#sb-a-logo').value = cfg.logoUrl || '';
    if ($('#sb-a-icon')) $('#sb-a-icon').value = cfg.faviconUrl || cfg.iconUrl || '';
    if ($('#sb-a-name')) $('#sb-a-name').value = cfg.brandName || '';
    if ($('#sb-a-css')) $('#sb-a-css').value = cfg.themeCss || '';
    if ($('#sb-a-logo-prev')) $('#sb-a-logo-prev').src = cfg.logoUrl || '';
    if ($('#sb-a-icon-prev')) $('#sb-a-icon-prev').src = cfg.faviconUrl || cfg.iconUrl || '';
  }

  function readFormConfig() {
    var cfg = normalizeConfig(state.config || defaultConfig());
    cfg.logoUrl = ($('#sb-a-logo') && $('#sb-a-logo').value.trim()) || '';
    cfg.iconUrl = ($('#sb-a-icon') && $('#sb-a-icon').value.trim()) || '';
    cfg.faviconUrl = cfg.iconUrl;
    cfg.brandName = ($('#sb-a-name') && $('#sb-a-name').value.trim()) || '';
    cfg.themeCss = ($('#sb-a-css') && $('#sb-a-css').value) || '';
    cfg.version = Date.now();
    cfg.updatedAt = new Date().toISOString();
    return cfg;
  }

  function setStatus(msg, isErr) {
    var el = $('#sb-a-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isErr ? '#d45a4a' : '#a69685';
  }

  function openPanel() {
    ensureAdminDom();
    fillFormFromConfig(state.config);
    $('#sb-admin-modal').classList.remove('hidden');
    setStatus('');
  }
  function closePanel() {
    var m = $('#sb-admin-modal');
    if (m) m.classList.add('hidden');
  }

  function saveConfig() {
    var cfg = readFormConfig();
    setStatus('Сохранение...');
    fetch(ADMIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ config: cfg, user: state.user ? { username: state.user.username } : null })
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null; try { data = JSON.parse(t); } catch(e) {}
        if (!r.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + r.status));
        return data || cfg;
      });
    }).then(function (saved) {
      var finalCfg = normalizeConfig((saved && saved.config) ? saved.config : (saved && saved.version != null ? saved : cfg));
      writeCache(finalCfg);
      applyConfig(finalCfg);
      fillFormFromConfig(finalCfg);
      setStatus('Сохранено');
    }).catch(function (e) {
      setStatus('Ошибка: ' + e.message, true);
    });
  }

  function resetConfig() {
    if (!confirm('Сбросить кастомный брендинг/тему на дефолт?')) return;
    var cfg = defaultConfig();
    cfg.version = Date.now();
    cfg.reset = true;
    setStatus('Сброс...');
    fetch(ADMIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ config: cfg, reset: true, user: state.user ? { username: state.user.username } : null })
    }).then(function (r) { return r.json().catch(function(){ return cfg; }); })
      .then(function () {
        try { localStorage.removeItem(CACHE_KEY); } catch(e) {}
        location.reload();
      })
      .catch(function () {
        try { localStorage.removeItem(CACHE_KEY); } catch(e) {}
        location.reload();
      });
  }

  function updateAdminUi() {
    ensureAdminDom();
    var show = isAdminUser(state.user);
    var fab = $('#sb-admin-fab');
    if (fab) fab.style.display = show ? '' : 'none';
    if (!show) closePanel();
  }

  function watchDomUser() {
    if (!window.MutationObserver) return;
    var pending = false;
    var obs = new MutationObserver(function () {
      var u = detectUserFromDom();
      if (u && (!state.user || state.user.username !== u.username)) setUser(u);
      if (!pending && state.config && (state.config.logoUrl || state.config.iconUrl)) {
        pending = true;
        setTimeout(function () { pending = false; try { applyImages(state.config); } catch(e) {} }, 50);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    var u = detectUserFromDom();
    if (u) setUser(u);
  }

  function init() {
    installFetchHook();
    var cached = readCache();
    if (cached) applyConfig(cached);
    fetchConfig();
    setInterval(fetchConfig, 60000);

    function onReady() {
      ensureAdminDom();
      watchDomUser();
      updateAdminUi();
      // Скрипт выполняется в <head>, поэтому при первом applyConfig элементы body
      // (логотип на экране входа и т.п.) ещё не в DOM. Повторяем применение после
      // готовности, чтобы подхватить и кеш, и уже загруженный с сервера конфиг.
      if (state.config) {
        try { applyConfig(state.config); } catch (e) {}
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady);
    } else {
      onReady();
    }
  }

  init();
})();
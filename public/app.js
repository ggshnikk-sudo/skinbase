import {
    CAPE_FACE, ELYTRA_FACE, loadTexture, previewCanvas, paintFrame, createFramePlayer, showLoading, showUnreadable,
  } from './cape-texture.js';
  import { readApiResponse } from './api-response.js';
  
  const API = {
    async request(method, path, body, isForm = false) {
      const opts = { method, headers: {} };
      if (body && !isForm) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      } else if (body && isForm) {
        opts.body = body;
      }
      const res = await fetch(path, opts);
      if (path.includes('/skin-file')) return res;
      return readApiResponse(res);
    },
  get: path => API.request('GET', path),
  post: (path, body) => API.request('POST', path, body),
  put: (path, body) => API.request('PUT', path, body),
  del: (path, body) => API.request('DELETE', path, body),
  postForm: (path, form) => API.request('POST', path, form, true),
};

// ─── Лимит загрузки ───
//
// Потолок живёт на сервере (GET /api/v3/limits), иначе форма отвергала бы
// файл, который бэкенд принял бы, и наоборот. Пока ответ не пришёл — берём то
// же число, что стоит в functions/_lib/limits.js, чтобы подсказка не мигала
// «2 МБ» на пустом месте.
const UPLOAD_LIMITS = { maxPngBytes: 20 * 1024 * 1024, maxPngMb: 20 };

async function loadUploadLimits() {
  try {
    const data = await API.get('/api/v3/limits');
    if (data && data.maxPngBytes > 0) {
      UPLOAD_LIMITS.maxPngBytes = data.maxPngBytes;
      UPLOAD_LIMITS.maxPngMb = data.maxPngMb || data.maxPngBytes / (1024 * 1024);
    }
  } catch {
    // Сеть или API лежат — оставляем потолок по умолчанию: проверку всё
    // равно делает бэкенд, это только подсказка.
  }
  const hint = document.getElementById('upload-limit-hint');
  if (hint) hint.textContent = hint.textContent.replace(/\d+ МБ/, `${UPLOAD_LIMITS.maxPngMb} МБ`);
  return UPLOAD_LIMITS;
}

let state = {
  user: null,
  skins: [],
  equipped: { cape: null },
  currentView: 'dashboard',
};

let selectedFile = null;

// root нужен для запросов внутри карточки: $$('.cape-mode', card) обязан
// вернуть кнопки ЭТОЙ карточки. Без второго аргумента поиск шёл по всему
// документу, buttons.includes(btn) не срабатывал, и переключение режима
// молча умирало.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function showView(name) {
  const view = $(`#view-${name}`);
  if (!view) return;
  $$('.view').forEach(v => { if (v !== view) v.classList.add('hidden'); });
  view.classList.remove('hidden');
  view.style.animation = 'none';
  requestAnimationFrame(() => { view.style.animation = ''; });
  state.currentView = name;
  $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.view === name));
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toast-container').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(40px)';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

async function apiWithLoading(btn, promise) {
  if (btn) { btn.disabled = true; btn.dataset.text = btn.textContent; btn.textContent = '...'; }
  try { return await promise; }
  finally { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.text || btn.textContent; } }
}

// ─── 3D-превью (только плащи) ───
// Chromium держит на странице 16 ЖИВЫХ WebGL-контекстов, и при превышении
// молча отбирает самый старый — карточка просто перестаёт рисовать (белое
// пятно), без всякой ошибки. Проверено в браузере: 20 вьюеров подряд дают
// 16 живых и 4 молчаливых трупа. Отсюда два ограничения:
//
//   • вьюер живёт только пока карточка в зоне видимости, и освобождение
//     двухуровневое:
//       — dispose() в skinview3d гасит анимацию и GPU-ресурсы, но КАНВАС из
//         контейнера не убирает: каждый цикл скролла подкладывал бы ещё
//         холст, и .skin-preview с overflow:hidden начинал резать картинку;
//       — renderer.dispose() не отпускает сам WebGL-контекст, слот продолжает
//         числиться занятым (44 предупреждения Chromium против 12 с
//         forceContextLoss) — пул забивается зомби и новые карточки
//         получают отобранный контекст;
//   • жёсткий потолок одновременных вьюеров: на 4K с масштабом 200% в зоне
//     видимости оказывается больше 16 карточек, и без потолка часть всё
//     равно останется белой. Кому места не хватило — плоская текстура.
const MAX_CAPE_VIEWERS = 14;

const capeViewers = new Map();
// Живых вьюеров на странице. Потолок ограничивает именно их: Chromium отдаёт
// 16 WebGL-контекстов и дальше убивает самые старые МОЛЧА. Плоские превью
// контекст не занимают, поэтому в потолок не входят и вытеснения их не касаются.
let capeViewersLive = 0;
// Сколько карточка может пробыть вне экрана, прежде чем отдать слот 3D.
const CAPE_OFFSCREEN_GRACE = 1500;
// Читается в момент ухода, а не один раз на загрузке: тесты подставляют своё
// значение через window.__capeOffscreenGrace. Без шва проверка «карточка
// вернулась до отпускания слота» мерила скорость машины, а не поведение: под
// нагрузкой два кадра браузера растягиваются за полторы секунды, и тест падал
// на ровном коде.
const offscreenGrace = () => {
  const v = Number(globalThis.__capeOffscreenGrace);
  return Number.isFinite(v) && v >= 0 ? v : CAPE_OFFSCREEN_GRACE;
};
let capeObserver = null;
let equipViewer = null;
let viewSeq = 0;

function mountCape(container, size) {
  const url = container && container.dataset.skin;
  if (!url) return null;
  return initCapeViewer(container, url, size);
}

function disposeCapeViewers() {
  if (capeObserver) {
    capeObserver.disconnect();
    capeObserver = null;
  }
  capeViewers.forEach(live => live.preview.dispose());
  capeViewers.clear();
  capeViewersLive = 0;
}

function mountCard(container, size) {
  const card = container.closest('.skin-card');
  const preview = card
    ? initCapePreview(card, size)
    : initCapeViewer(container, container.dataset.skin, size);
  if (preview) capeViewers.set(container, { preview, seen: ++viewSeq });
}

// При превышении потолка выкидываем самые давно замеченные вьюеры. Выкинутая
// карточка, если она всё ещё на экране, сразу получает плоскую текстуру —
// mountCard сам опустится до запасного варианта, потолка не превысит и не
// закрутится в цикл.
function oldestViewer(except) {
  let victim = null;
  for (const [container, live] of capeViewers) {
    if (container === except || !live.preview.hasViewer()) continue;
    if (!victim) { victim = [container, live]; continue; }
    // Жертвой становится то, чего на экране нет, а среди равных — самое давно
    // показанное. Запись пула — это {preview, seen}, видимость лежит в preview.
    const victimShown = victim[1].preview.isVisible();
    const liveShown = live.preview.isVisible();
    if (victimShown && !liveShown) { victim = [container, live]; continue; }
    if (victimShown === liveShown && live.seen < victim[1].seen) {
      victim = [container, live];
    }
  }
  return victim;
}

// Вытеснение по таймеру убрано намеренно: оно и было причиной метаний между 3D
// и 2D. Вьюер освобождается, когда карточка уходит из зоны видимости (наблюдатель
// зовёт dispose), а по клику «Крылья» слот отбирается у самой давно показанной
// карточки, которой всё равно вернут 3D при возврате в экран.
function trimViewers() {}

function observeCapeCards() {
  const cards = $$('.skin-canvas-container');
  if (cards.length === 0) return;
  if (typeof IntersectionObserver === 'undefined') {
    cards.forEach(card => mountCard(card, 200));
    return;
  }
  capeObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        if (capeViewers.has(entry.target)) {
          const live = capeViewers.get(entry.target);
          live.seen = ++viewSeq;
          live.preview.setVisible(true);
          live.preview.restore();
        } else {
          mountCard(entry.target, 200);
        }
      } else {
        const live = capeViewers.get(entry.target);
        if (live) {
          live.seen = ++viewSeq;
          // Слот отпускается не здесь, а через CAPE_OFFSCREEN_GRACE: пока
          // карточка не вернулась, 3D остаётся и глаз не ловит переключение.
          live.preview.setVisible(false);
        }
      }
    }
    trimViewers();
  }, { rootMargin: '120px 0px' });
  cards.forEach(card => capeObserver.observe(card));
}

function initCapeViewer(container, skinUrl, size, onReady, loadOpts) {
  try {
    if (typeof skinview3d === 'undefined') return initCapeFallback(container);
    const viewer = new skinview3d.SkinViewer({ width: size, height: size });
    viewer.background = 0x0d0b1a;
    viewer.autoRotate = true;
    viewer.zoom = 1.2;
    container.replaceChildren(viewer.canvas);

    // Контекст могут отобрать молча — показываем причину, а не пустоту.
    const onContextLost = () => container.classList.add('cape-failed');
    viewer.canvas.addEventListener('webglcontextlost', onContextLost);

    viewer.loadSkin(null);
    // backEquipment передаётся в loadCape, а не выставляется после: модель
    // хвоста/крыльев создаётся внутри loadCape и применяет опцию сам. Кто
    // выставит backEquipment до или сразу после, того значение затрёт дефолт.
    viewer.loadCape(skinUrl, loadOpts || {}).catch((e) => {
      console.error('Не удалось загрузить текстуру плаща:', skinUrl, e);
      container.classList.add('cape-failed');
    });

    // Модель с хвостом и крыльями создаётся сразу, до loadCape, — значит
    // переключать режим можно сразу же, не дожидаясь текстуры.
    if (onReady) onReady(viewer);

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      viewer.canvas.removeEventListener('webglcontextlost', onContextLost);
      viewer.dispose();
      if (viewer.renderer && viewer.renderer.forceContextLoss) viewer.renderer.forceContextLoss();
      container.replaceChildren();
    };
    return { dispose, demote: dispose, hasViewer: () => true };
  } catch (e) {
    console.error('skinview3d init error:', e);
    return initCapeFallback(container);
  }
}

// Запасной вариант без WebGL: плоская текстура плаща. Кривая всегда, зато
// никогда не белая и не стоит контекста.
// Запасной путь без WebGL: контейнер остаётся пустым, картинку рисует
// плоское превью ниже, из уже разобранной текстуры. Показывать здесь исходный
// файл нельзя — для стака это каша всех кадров, а для статичного плаща —
// нечитаемый атлас 64×32; и то и другое пользователь читает как «сломанный
// плащ», а не как его вид сзади.
function initCapeFallback(container) {
  container.replaceChildren();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    container.replaceChildren();
  };
  return { dispose, demote: dispose, hasViewer: () => false };
}

// ─── Режим превью и проверка крыльев ───
//
// «Плащ» и «Крылья» — это не два разных рендера, а переключение видимости на
// одной и той же модели: skinview3d держит и хвост, и крылья в одном меше и
// переключает их через playerObject.backEquipment. Стоит ноль дополнительных
// WebGL-контекстов, поэтому тумблер не упирается в потолок из 16.
//
// Плоский запасной вариант вырезает из атласа одну читаемую грань: лицо хвоста
// (x∈[1,11), y∈[1,17)) или широкую панель крыла (x∈[24,34), y∈[2,22)). Области
// не пересекаются, так что честный «нет крыльев» выглядит пустотой, а не
// выдуманной картинкой. Тумблер показывается, только если крылья реально есть.

// Плоское превью: в режиме элитр хвост и панель крыла рядом, как в 3D.
// Соотношение 21×20 почти квадратное, и карточка не выглядит «текстуркой,
// которая не загрузилась».
const CAPE_MODES = {
  cape: CAPE_FACE,
  elytra: { parts: [CAPE_FACE, ELYTRA_FACE], gap: 1 },
};

function setElytraBadge(card, verdict) {
  const badge = card.querySelector('.elytra-badge');
  if (!badge) return;
  badge.className = `elytra-badge is-${verdict.level}`;
  badge.textContent = verdict.level === 'yes' ? '✓ крылья' : verdict.label;
  badge.title = verdict.hint;
}

// Тумблер «Плащ/Крылья» без крыльев бессмыслен: переключать не на что, а кнопка
// выглядит как обещание. Поэтому она появляется только при вердикте yes.
function setElytraToggle(card, verdict) {
  const modes = card.querySelector('.cape-modes');
  if (!modes) return;
  const show = Boolean(verdict && verdict.ok);
  modes.classList.toggle('hidden', !show);
  if (!show) {
    card.querySelectorAll('.cape-mode').forEach(b => {
      b.classList.toggle('is-active', b.dataset.mode === 'cape');
    });
  }
}

// Плоское превью области: канвас на карточку, кадры перерисовываются на месте.
// Отдельный canvas на каждый кадр плодил бы мусор в DOM.
//
// При смене режима канвас пересоздаётся: хвост — 10×16, «хвост + крыло» —
// 21×20, и втискивание одного в форму другого даёт пустые поля, которые
// выглядят как недогруженная текстура.
function startFlatPreview(container, texture, mode, size) {
  const player = createFramePlayer();
  let canvas = null;
  const draw = (m) => {
    const next = previewCanvas(size, CAPE_MODES[m]);
    next.dataset.previewMode = m;
    player.start(next.getContext('2d'), texture, CAPE_MODES[m]);
    container.replaceChildren(next);
    canvas = next;
  };
  draw(mode);
  return {
    get canvas() { return canvas; },
    repaintMode: m => draw(m),
    stop: () => player.stop(),
  };
}

// Всё превью карточки целиком: текстура, вердикт по крыльям, тумблер режима.
// Возвращает функцию освобождения или null, если превью нечего показывать.
function initCapePreview(card, size) {
  const container = card.querySelector('.skin-canvas-container');
  const url = container && container.dataset.skin;
  if (!url) return null;

  const buttons = $$('.cape-mode', card);
  let mode = 'cape';
  let texture = null;
  let viewer = null;
  let flat = null;
  let disposeViewer = null;
  let disposed = false;

  const applyMode = () => {
    if (disposed) return;
    if (viewer && viewer.playerObject) {
      // У skinview3d хвост и крылья — один меш, переключается видимость.
      viewer.playerObject.backEquipment = mode;
    } else if (flat) {
      flat.repaintMode(mode);
    }
  };

  // Карточка без 3D показывает плоский композит. Сам по себе он честный, но
  // по нажатию «Крылья» пользователь ждёт объёмные крылья, а получает
  // развёрнутую текстуру — и считает, что крылья сломаны. Поэтому по
  // требованию карточка поднимается в 3D: слот вытесняется у самой давно
  // замеченной карточки, она получает плоский вариант и ничего не теряет.
  let previewApi = null;
  const promote = () => {
    if (viewer || disposed || typeof skinview3d === 'undefined') return false;
    if (capeViewersLive >= MAX_CAPE_VIEWERS) {
      const victim = oldestViewer(container);
      if (victim) victim[1].preview.demote();
    }
    const live = capeViewers.get(container);
    if (live) live.seen = ++viewSeq;
    const disposer = initCapeViewer(container, url, size, v => {
      viewer = v;
      capeViewersLive++;
      applyMode();
    }, { backEquipment: mode });
    if (!disposer || !disposer.hasViewer()) return false;
    disposeViewer = disposer;
    if (flat) { flat.stop(); flat = null; }
    if (!live) capeViewers.set(container, { preview: previewApi, seen: ++viewSeq });
    return true;
  };

  const onClick = e => {
    const btn = e.target.closest('.cape-mode');
    if (!btn || !buttons.includes(btn) || disposed) return;
    mode = btn.dataset.mode;
    buttons.forEach(b => b.classList.toggle('is-active', b === btn));
    if (mode === 'elytra' && !viewer) promote();
    applyMode();
  };
  card.addEventListener('click', onClick);

  // Поднять карточку в 3Д, только если слот свободен: отбирать слот у того, что
  // пользователь сейчас смотрит, нельзя — карточки начинают метаться между 3Д
  // и 2Д при каждом движении наблюдателя.
  const mount3D = () => {
    if (viewer || disposed || typeof skinview3d === 'undefined') return false;
    if (capeViewersLive >= MAX_CAPE_VIEWERS) return false;
    const d = initCapeViewer(container, url, size, v => {
      viewer = v;
      capeViewersLive++;
      applyMode();
    }, { backEquipment: mode });
    if (!d || !d.hasViewer()) return false;
    disposeViewer = d;
    if (flat) { flat.stop(); flat = null; }
    return true;
  };

  if (capeViewersLive < MAX_CAPE_VIEWERS) mount3D();
  if (!viewer) disposeViewer = disposeViewer || initCapeFallback(container);

  // Текстура нужна вердикту по крыльям, а в плоском варианте — ещё и самой
  // картинке. Разбор отложен: 3D-вьюер к этому моменту уже рисует плащ.
  // Пока идёт разбор, в пустом контейнере стоит заглушка — иначе тяжёлый файл
  // снаружи выглядит как «плащ не показался».
  showLoading(container);
  loadTexture(url).then(tex => {
    if (disposed) return;
    texture = tex;
    setElytraBadge(card, tex.verdict);
    setElytraToggle(card, tex.verdict);
    // 3D-вьюер уже на месте — он рисует и хвост, и крылья сам.
    if (viewer) return;
    flat = startFlatPreview(container, tex, mode, size);
  }).catch(e => {
    if (disposed) return;
    console.warn('Не удалось разобрать текстуру плаща:', url, e);
    const badge = card.querySelector('.elytra-badge');
    if (badge) {
      badge.className = 'elytra-badge is-unknown';
      badge.textContent = 'не проверили';
    }
    setElytraToggle(card, null);
    if (!disposeViewer) disposeViewer = initCapeFallback(container);
    showUnreadable(container, url);
  });

  let done = false;
  // Превью создаётся только из наблюдателя, то есть карточка на экране.
  let visible = true;
  let leaveTimer = null;

  function dispose() {
    if (done) return;
    done = true;
    disposed = true;
    card.removeEventListener('click', onClick);
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    if (flat) flat.stop();
    if (disposeViewer) disposeViewer.dispose();
    if (viewer) capeViewersLive--;
  }

  // Слот отдан другой карточке: вьюер освобождается, но превью остаётся видимым.
  function demote() {
    if (disposed) return;
    if (disposeViewer) {
      disposeViewer.dispose();
      disposeViewer = null;
      if (viewer) capeViewersLive--;
    }
    viewer = null;
    if (!flat && texture) flat = startFlatPreview(container, texture, mode, size);
  }

  const hasViewer = () => Boolean(viewer);
  // Видимость с задержкой отпускания слота. Мгновенный demote на уходе
  // означал, что обычная прокрутка мимо карточки перерисовывала её заново —
  // карточки «переходили из одного состояния в другое» на глазах.
  const setVisible = (v) => {
    if (visible === v) return;
    visible = v;
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    if (!v) {
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (!visible && !disposed) demote();
      }, offscreenGrace());
    }
  };
  // Карточка вернулась в зону видимости: если слот освободился, 3D возвращается
  // сам. Молча, без обмена слотами с другими видимыми карточками.
  const restore = () => { if (!viewer) mount3D(); };
  previewApi = { dispose, demote, hasViewer, setVisible, isVisible: () => visible, restore };
  return previewApi;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Библиотека ───
function renderSkins() {
  disposeCapeViewers();

  const grid = $('#skins-grid');
  const list = state.skins;
  const equippedId = state.equipped.cape?.id;

  if (list.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🦅</div>
        <p>Плащей пока нет</p>
        <small>Добавьте первый плащ через «+ Добавить»</small>
      </div>`;
    return;
  }

  grid.innerHTML = list.map(skin => {
    const isEquipped = skin.id === equippedId;
    const tags = skin.tags ? skin.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    return `
      <div class="skin-card ${isEquipped ? 'equipped' : ''}" data-id="${skin.id}">
        ${isEquipped ? '<div class="equipped-badge">✦</div>' : ''}
        <div class="skin-preview">
          <div class="skin-canvas-container" data-skin="${skin.url}"></div>
          <div class="cape-modes hidden" role="group" aria-label="Что показать: плащ или крылья">
            <button type="button" class="cape-mode is-active" data-mode="cape">Плащ</button>
            <button type="button" class="cape-mode" data-mode="elytra">Крылья</button>
          </div>
        </div>
        <div class="skin-info">
          <div class="skin-info-top">
            <span class="skin-name">${escapeHtml(skin.name)}</span>
            <span class="skin-category cape">Плащ</span>
          </div>
          <div class="skin-meta">
            <span class="elytra-badge is-pending">проверяем крылья…</span>
            ${tags.length ? `<div class="skin-tags">${tags.map(t => `<span class="skin-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="skin-actions">
            <button class="btn btn-sm ${isEquipped ? 'btn-primary' : 'btn-ghost'} equip-btn" data-id="${skin.id}">✦ ${isEquipped ? 'Экип.' : 'Надеть'}</button>
            <button class="btn btn-sm btn-ghost open-btn" data-id="${skin.id}" title="Открыть файл">↗</button>
            <button class="btn btn-sm btn-ghost edit-btn" data-id="${skin.id}" title="Редактировать">✎</button>
            ${state.user?.canDelete ? `<button class="btn btn-sm btn-danger delete-btn" data-id="${skin.id}" title="Удалить">✕</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  requestAnimationFrame(observeCapeCards);
}

async function loadSkins() {
  try {
    const params = new URLSearchParams();
    const searchVal = $('#search-input').value.trim();
    if (searchVal) params.set('search', searchVal);
    const data = await API.get(`/api/v3/skins?${params}`);
    state.skins = data.skins;
    renderSkins();
  } catch (e) {
    toast('Ошибка загрузки плащей: ' + e.message, 'error');
  }
}

async function loadEquipped() {
  try {
    const data = await API.get('/api/v3/equip');
    state.equipped = data.equipped;
    renderEquipped();
  } catch (e) {
    toast('Ошибка загрузки экипировки: ' + e.message, 'error');
  }
}

// ─── Экипировка ───
function renderEquipped() {
  const slot = $('#equip-cape');
  const skin = state.equipped.cape;
  const clearBtn = $('.slot-clear[data-category="cape"]');

  // Слот экипировки живёт своей жизнью — сбрасываем только его вьюер. Раньше
  // здесь стоял disposeCapeViewers(), который гасил заодно наблюдатель
  // карточек: после любой экипировки превью в библиотеке пропадали навсегда,
  // потому что observeCapeCards() больше никто не звал.
  // Сброс слота идёт через dispose(), а не через сам объект: initCapeViewer
  // отдаёт { dispose, demote, hasViewer }, и вызов его как функции падал с
  // «equipViewer is not a function» — то есть на каждой переэкипировке.
  if (equipViewer) {
    equipViewer.dispose();
    equipViewer = null;
  }

  if (skin) {
    slot.innerHTML = `<div class="equip-container" data-skin="${skin.url}"></div>`;
    requestAnimationFrame(() => {
      const container = slot.querySelector('.equip-container');
      if (container) equipViewer = mountCape(container, 150);
    });
    if (clearBtn) clearBtn.classList.remove('hidden');  } else {
    slot.innerHTML = `<span class="empty-slot">Пусто</span>`;
    if (clearBtn) clearBtn.classList.add('hidden');
  }
}

// ─── Бэкап-модалка (миграция) ───
async function checkBackup() {
  try {
    const data = await API.get('/api/v3/backup');
    if (!data.exists) return;
    $('#backup-count').textContent = data.count;
    $('#backup-modal').classList.remove('hidden');
  } catch (e) {
    console.warn('backup check failed:', e);
  }
}

$('#backup-download-btn').addEventListener('click', () => {
  window.location.href = '/api/v3/backup/download';
});

$('#backup-decline-btn').addEventListener('click', async () => {
  try {
    await API.post('/api/v3/backup/decline');
  } catch {}
  $('#backup-modal').classList.add('hidden');
});

// ─── Auth ───
async function checkAuth() {
  try {
    const data = await API.get('/api/v3/me');
    state.user = data.user;
    if (state.user) {
      $('#navbar').classList.remove('hidden');
      $('#view-auth').classList.add('hidden');
      $('#nav-username').textContent = state.user.username;
      await Promise.all([loadSkins(), loadEquipped()]);
      showView('dashboard');
      checkBackup();
    } else {
      $('#navbar').classList.add('hidden');
      $('#view-auth').classList.remove('hidden');
      showView('auth');
    }
  } catch {
    $('#navbar').classList.add('hidden');
    $('#view-auth').classList.remove('hidden');
    showView('auth');
  }
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const isLogin = document.querySelector('.auth-tab.active').dataset.tab === 'login';
  const errorEl = $('#auth-error');
  const submitBtn = $('#auth-submit');

  errorEl.classList.add('hidden');
  await apiWithLoading(submitBtn, (async () => {
    const data = isLogin
      ? await API.post('/api/v3/login', { username, password })
      : await API.post('/api/v3/register', { username, password });
    state.user = data.user;
    $('#navbar').classList.remove('hidden');
    $('#view-auth').classList.add('hidden');
    $('#nav-username').textContent = data.user.username;
    await Promise.all([loadSkins(), loadEquipped()]);
    showView('dashboard');
    toast(isLogin ? 'Добро пожаловать!' : 'Аккаунт создан!', 'success');
    checkBackup();
  })().catch(e => {
    errorEl.textContent = e.message;
    errorEl.classList.remove('hidden');
  }));
});

$$('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('#auth-submit').textContent = tab.dataset.tab === 'login' ? 'Войти' : 'Создать аккаунт';
    $('#auth-error').classList.add('hidden');
  });
});

$('#logout-btn').addEventListener('click', async () => {
  await API.post('/api/v3/logout');
  state.user = null;
  state.skins = [];
  state.equipped = { cape: null };
  // Сетка не перерисовывается, поэтому освобождать вьюеры надо здесь —
  // иначе до перезагрузки страницы висят все контексты снятого пользователя.
  disposeCapeViewers();
  if (equipViewer) {
    equipViewer.dispose();
    equipViewer = null;
  }
  $('#navbar').classList.add('hidden');
  $('#view-auth').classList.remove('hidden');
  showView('auth');
  toast('Вы вышли', 'info');
});

// ─── Навигация ───
$$('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    const view = link.dataset.view;
    if (view === 'dashboard') { loadSkins(); showView('dashboard'); }
    else if (view === 'equipped') { loadEquipped(); showView('equipped'); }
    else if (view === 'add') { resetForm(); showView('add'); }
    else if (view === 'tokens') { loadTokens(); showView('tokens'); }
  });
});

let searchTimeout;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadSkins, 300);
});

// ─── Drag&drop загрузка ───
const dropZone = $('#drop-zone');
const fileInput = $('#skin-file-input');

function setDropFile(file) {
  if (!file) return;
  if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) {
    toast('Только PNG файлы', 'error');
    return;
  }
  if (file.size > UPLOAD_LIMITS.maxPngBytes) {
    toast(`Файл больше ${UPLOAD_LIMITS.maxPngMb} МБ`, 'error');
    return;
  }
  selectedFile = file;
  $('.drop-text').textContent = file.name;
  $('.drop-hint').textContent = (file.size / 1024).toFixed(0) + ' КБ · готов к загрузке';
  dropZone.classList.add('has-file');
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  setDropFile(fileInput.files[0]);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
  });
});
dropZone.addEventListener('drop', e => {
  setDropFile(e.dataTransfer.files[0]);
});

// ─── Форма ───
function resetForm(editData) {
  $('#skin-id').value = '';
  $('#skin-name').value = '';
  $('#skin-tags').value = '';
  selectedFile = null;
  $('.drop-text').textContent = 'Перетащите PNG сюда';
  $('.drop-hint').textContent = 'или нажмите, чтобы выбрать файл';
  dropZone.classList.remove('has-file');
  $('#skin-submit').textContent = 'Сохранить';
  $('#skin-cancel').classList.add('hidden');
  $('#view-add .view-title').textContent = 'Добавить плащ';
  if (editData) {
    $('#skin-id').value = editData.id;
    $('#skin-name').value = editData.name;
    $('#skin-tags').value = editData.tags || '';
    $('#skin-submit').textContent = 'Обновить';
    $('#skin-cancel').classList.remove('hidden');
    $('#view-add .view-title').textContent = 'Редактировать плащ';
  }
}

$('#skin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#skin-id').value;
  const name = $('#skin-name').value.trim();
  const tags = $('#skin-tags').value.trim();

  if (!name) {
    toast('Введите название', 'error');
    return;
  }

  const btn = $('#skin-submit');
  await apiWithLoading(btn, (async () => {
    if (id) {
      await API.put(`/api/v3/skins/${id}`, { name, tags });
      toast('Плащ обновлён', 'success');
    } else {
      if (!selectedFile) {
        toast('Выберите PNG файл', 'error');
        return;
      }
      const form = new FormData();
      form.append('file', selectedFile);
      form.append('name', name);
      form.append('tags', tags);
      await API.postForm('/api/v3/upload', form);
      toast('Плащ добавлен', 'success');
    }
    resetForm();
    await loadSkins();
    showView('dashboard');
  })().catch(e => toast(e.message, 'error')));
});

$('#skin-cancel').addEventListener('click', () => {
  resetForm();
  showView('dashboard');
});

// ─── Действия на карточках ───
$('#skins-grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;

  if (btn.classList.contains('equip-btn')) {
    await apiWithLoading(btn, (async () => {
      await API.post('/api/v3/equip', { skin_id: parseInt(id) });
      await Promise.all([loadSkins(), loadEquipped()]);
      toast('Экипировано', 'success');
    })().catch(e => toast(e.message, 'error')));
  } else if (btn.classList.contains('open-btn')) {
    const skin = state.skins.find(s => s.id == id);
    window.open(skin?.file || `/api/v3/skin-file/${id}.png`, '_blank');
  } else if (btn.classList.contains('edit-btn')) {
    const skin = state.skins.find(s => s.id == id);
    if (skin) { resetForm(skin); showView('add'); }
  } else if (btn.classList.contains('delete-btn')) {
    if (!confirm('Удалить этот плащ?')) return;
    await apiWithLoading(btn, (async () => {
      await API.del(`/api/v3/skins/${id}`);
      await Promise.all([loadSkins(), loadEquipped()]);
      toast('Плащ удалён', 'info');
    })().catch(e => toast(e.message, 'error')));
  }
});

// ─── Снять плащ ───
document.querySelectorAll('.slot-clear').forEach(btn => {
  btn.addEventListener('click', async () => {
    await apiWithLoading(btn, (async () => {
      await API.del('/api/v3/equip');
      await Promise.all([loadSkins(), loadEquipped()]);
      toast('Снято', 'info');
    })().catch(e => toast(e.message, 'error')));
  });
});

// ─── API-токены ───
async function loadTokens() {
  try {
    const data = await API.get('/api/v3/tokens');
    const list = $('#tokens-list');
    const tokens = data.tokens || [];
    if (tokens.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔑</div>
          <p>Токенов пока нет</p>
          <small>Создайте первый — он даст программам доступ к вашему аккаунту</small>
        </div>`;
      return;
    }
    list.innerHTML = tokens.map(t => `
      <div class="token-card ${t.revoked ? 'revoked' : ''}">
        <div class="token-info">
          <span class="token-name">${escapeHtml(t.name)}</span>
          <span class="token-meta">
            Создан: ${t.created_at ? t.created_at.slice(0, 16).replace('T', ' ') : '—'}
            ${t.last_used_at ? ' · Использован: ' + t.last_used_at.slice(0, 16).replace('T', ' ') : ''}
            ${t.revoked ? ' · <span class="token-revoked">отозван</span>' : ''}
          </span>
        </div>
        ${t.revoked ? '' : `<button class="btn btn-sm btn-danger token-revoke-btn" data-id="${t.id}">Отозвать</button>`}
      </div>`).join('');
  } catch (e) {
    $('#tokens-list').innerHTML = `<div class="empty-state"><p>Ошибка: ${escapeHtml(e.message)}</p></div>`;
  }
}

$('#token-create-btn').addEventListener('click', () => {
  $('#token-name-input').value = '';
  $('#token-create-modal').classList.remove('hidden');
  setTimeout(() => $('#token-name-input').focus(), 50);
});

$('#token-create-cancel').addEventListener('click', () => {
  $('#token-create-modal').classList.add('hidden');
});

$('#token-create-confirm').addEventListener('click', async () => {
  const name = $('#token-name-input').value.trim() || 'API';
  const btn = $('#token-create-confirm');
  await apiWithLoading(btn, (async () => {
    const data = await API.post('/api/v3/tokens', { name });
    $('#token-create-modal').classList.add('hidden');
    $('#token-value').value = data.token.token;
    $('#token-modal-title').textContent = 'Новый API-токен';
    $('#token-modal-text').textContent = 'Скопируйте его — он показывается только один раз и хранится в зашифрованном виде.';
    $('#token-modal').classList.remove('hidden');
    loadTokens();
  })().catch(e => toast(e.message, 'error')));
});

$('#token-copy-btn').addEventListener('click', async () => {
  const input = $('#token-value');
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Токен скопирован', 'success');
  } catch {
    document.execCommand('copy');
    toast('Токен скопирован', 'success');
  }
});

$('#token-done-btn').addEventListener('click', () => {
  $('#token-modal').classList.add('hidden');
  $('#token-value').value = '';
});

$('#tokens-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.token-revoke-btn');
  if (!btn) return;
  if (!confirm('Отозвать этот токен? Программы, использующие его, потеряют доступ.')) return;
  await apiWithLoading(btn, (async () => {
    await API.del(`/api/v3/tokens/${btn.dataset.id}`);
    toast('Токен отозван', 'info');
    loadTokens();
  })().catch(e => toast(e.message, 'error')));
});

// ─── Init ───
loadUploadLimits();
checkAuth();
// Внутренности для браузерных тестов: app.js — ESM-модуль, и в window их
// больше нет, а проверять надо именно этот файл, а не его копию.
export {
  state, renderSkins, renderEquipped, showView,
  initCapeViewer, initCapePreview, disposeCapeViewers,
  MAX_CAPE_VIEWERS,
};

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlcyI6WyJhcHAuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLypcbiAqIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkFxuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKlxuICogINCj0LLQsNC20LDQtdC80YvQuSDRhdCw0LrQtdGALCDQsdGD0LTRjNGC0LUg0LTQvtCx0YDRiywg0L/QvtC50YLQuCDQvdCw0YXRg9C5LiAgICAqXG4gKiAg0JvRg9GH0YjQtSDQvdCw0YPRh9C40YLQtdGB0Ywg0L/QvtC70YzQt9C+0LLQsNGC0YzRgdGPINCz0YPQs9C70L7QvCwgICAgICAgICAgICpcbiAqICDQvdC10LbQtdC70Lgg0YHRgtGA0LDQtNCw0YLRjCDQtdGA0YPQvdC00L7QuS4gICAgICAgICAgICAgICAgICAgICAgICpcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICpcbiAqIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkFxuICovXG5cbid1c2Ugc3RyaWN0JztcblxuLy8gU291cmNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlLlxuLy8gVGhlIGZpbmVzdCBjb2RlIGlzIHRoZSBvbmUgeW91IG5ldmVyIGdldCB0byByZWFkLlxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuXG5cblxuIl0sIm1hcHBpbmdzIjoiQUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEifQ==

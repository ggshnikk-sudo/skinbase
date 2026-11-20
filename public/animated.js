// SkinBase · Анимированные капы (+/api/animated/v1)
//
// Stacked PNG — это лист кадров друг под другом. Показывать его целиком
// (<img src>) нельзя: получится каша из всех кадров, растянутая по высоте.
//
// Но анимированный кап — это обычный плащ, просто с кадрами. Значит и рисовать
// его надо как обычный: на модели игрока через skinview3d. Каждый кадр — полный
// атлас (64×32 в ванили, 64k×32k в HD), поэтому анимация — это подмена
// текстуры плаща раз в кадр. Разбор PNG и вердикт по крыльям — в cape-texture.js.

import {
  ATLAS_H,
  loadTexture,
  createFramePlayer,
  previewCanvas, showLoading, showUnreadable,
  frameRect,
  CAPE_FACE,
  ELYTRA_FACE,
} from './cape-texture.js';
  import { readApiResponse } from './api-response.js';
  
  const API_BASE = '/api/animated/v1';
  
  const API = {
    async request(method, path, body, isForm = false) {
      const opts = { method, headers: {} };
      if (body && !isForm) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      } else if (body && isForm) {
        opts.body = body;
      }
      let res;
      try {
        res = await fetch(path, opts);
      } catch {
        throw new Error('Сервер недоступен');
      }
      if (path.includes('/skin-file')) return res;
      // Раньше здесь стояло `.catch(() => ({}))`: не-JSON молча превращался в
      // пустой объект, и ошибка всплывала позже как «Что-то пошло не так» без
      // единого слова о причине.
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
// же число, что стоит в functions/_lib/limits.js.
const UPLOAD_LIMITS = { maxPngBytes: 20 * 1024 * 1024, maxPngMb: 20 };

async function loadUploadLimits() {
  try {
    const data = await API.get('/api/v3/limits');
    if (data && data.maxPngBytes > 0) {
      UPLOAD_LIMITS.maxPngBytes = data.maxPngBytes;
      UPLOAD_LIMITS.maxPngMb = data.maxPngMb || data.maxPngBytes / (1024 * 1024);
    }
  } catch {
    // Проверку всё равно делает бэкенд, это только подсказка.
  }
  const hint = document.getElementById('upload-limit-hint');
  if (hint) hint.textContent = hint.textContent.replace(/\d+ МБ/, `${UPLOAD_LIMITS.maxPngMb} МБ`);
  return UPLOAD_LIMITS;
}

let state = {
  user: null,
  skins: [],
  equipped: { animated: null },
  currentView: 'dashboard',
};

let selectedFile = null;

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function showView(name) {
  const view = $(`#view-${name}`);
  if (!view) return;
  $$('.view').forEach(v => { if (v !== view) v.classList.add('hidden'); });
  view.classList.remove('hidden');
  view.style.animation = 'none';
  requestAnimationFrame(() => { view.style.animation = ''; });
  state.currentView = name;
  $$('.nav-link[data-view]').forEach(l => l.classList.toggle('active', l.dataset.view === name));
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Превью анимированного плаща ───
//
// Анимированный кап — это обычный плащ, просто с кадрами. Значит и рисуем его
// как обычный: на модели игрока через skinview3d. Каждый кадр — полный атлас
// (64×32 в ванили, 64k×32k в HD), поэтому анимация сводится к подмене текстуры
// плаща раз в кадр: рисуем кадр в capeCanvas вьюера и помечаем текстуру dirty.
//
// Держать вьюер на каждую карточку нельзя: Chromium отдаёт странице не больше
// 16 WebGL-контекстов, дальше молча убивает самые старые. Поэтому вьюер получают
// только видимые карточки, не больше MAX_ANIM_VIEWERS, и освобождается, как
// только карточка ушла за экран. Кому вьюера не хватило — плоская анимация той
// же области (лицо хвоста). 2D-канвас контекста не занимает, поэтому доступен
// всегда: страницу не сломать количеством карточек.
//
// Текстуру — разобранный PNG — при этом не выбрасываем: остановка лишь гасит
// таймер, декодирование делается один раз на карточку.

// Режимы плоского превью. В режиме элитр показываем хвост и широкую панель
// крыла ВМЕСТЕ — ровно то, что видно в 3D при backEquipment=elytra. Одна
// панель 10×20 в квадратной карточке выглядит узкой полосой с пустотами и
// читается как «текстура не загрузилась»; хвост с крылом дают 21×20 — почти
// квадрат и вид сзади.
const CAPE_MODES = {
  cape: CAPE_FACE,
  elytra: { parts: [CAPE_FACE, ELYTRA_FACE], gap: 1 },
};
const ANIM_FPS = 12;
// Потолок вьюеров: Chromium держит 16 живых WebGL-контекстов, а на 17-м
// контекст умирает МОЛЧА — без события webglcontextlost, поэтому лишний
// вьюер выглядел бы как «у этого плаща нет превью». 14 оставляет два слота
// на всё остальное, что рисуется на странице через WebGL.
const MAX_ANIM_VIEWERS = 14;
const ANIM_OBSERVER_MARGIN = 120;

const animPreviews = new Map(); // контейнер -> объект превью
let animViewers = 0;            // живых WebGL-вьюеров на странице
let viewSeq = 0;                // порядок последнего показа, для выбора жертвы
// Сколько карточка может пробыть вне экрана, прежде чем отдать слот 3D.
const ANIM_OFFSCREEN_GRACE = 1500;
// Читается в момент ухода, а не один раз на загрузке, — см. шов в app.js.
const offscreenGrace = () => {
  const v = Number(globalThis.__capeOffscreenGrace);
  return Number.isFinite(v) && v >= 0 ? v : ANIM_OFFSCREEN_GRACE;
};

function setElytraBadge(card, verdict) {
  const badge = card.querySelector('.elytra-badge');
  if (!badge) return;
  badge.className = `elytra-badge is-${verdict.level}`;
  badge.textContent = verdict.level === 'yes' ? '✓ крылья' : verdict.label;
  badge.title = verdict.hint;
}

function failBadge(card, text) {
  const badge = card.querySelector('.elytra-badge');
  if (!badge) return;
  badge.className = 'elytra-badge is-unknown';
  badge.textContent = text;
}

// Тумблер без крыльев — обещание, которое нечем выполнить. Показываем только
// при вердикте yes, как и на статичных карточках.
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

// Всё превью одной карточки: текстура, вьюер либо 2D-канвас, тумблер, вердикт.
// Возвращает { show, hide, dispose } — наблюдатель зовёт show/hide, а
// перерисовка сетки — dispose.
function initAnimPreview(card, size) {
  const container = card.querySelector('.skin-canvas-container');
  const url = container && container.dataset.skin;
  if (!url) return null;

  const buttons = Array.from(card.querySelectorAll('.cape-mode'));
  let mode = 'cape';
  let texture = null;
  let viewer = null;
  let flat = null;   // { canvas, player } — запасной 2D-вариант
  let timer = null;
  let frame = 0;
  let loading = null;
  let disposed = false;
  let visible = false;   // карточка сейчас в зоне видимости
  let seen = 0;          // порядок «последнего показа» — для выбора жертвы
  let leaveTimer = null;

  // Видимость с задержкой отпускания слота: пока карточка не вернулась, 3D
  // остаётся на месте. Иначе прокрутка мимо карточки выглядит как «то 3D, то
  // 2D» — ровно то, на что жаловались.
  const setVisible = (v) => {
    if (visible === v) return;
    visible = v;
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    if (!v) {
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (!visible && !disposed && viewer) releaseViewer();
      }, offscreenGrace());
    }
  };

  const frameCount = () => (texture ? Math.max(1, texture.geometry.frames) : 1);

  // Нормализованный кадр, который скармливается loadCape: атлас (64×32, либо
  // 22×17 / 46×22) в размере уменьшенного кадра. k — сколько пикселей
  // приходится на тексель атласа; он держится целым, потому что skinview3d
  // проверяет пропорции строго, и кадр, у которого из-за округления ширина не
  // ровно вдвое больше высоты, отвергается с «Bad cape size».
  //
  // Считать k надо от ПРЕВЬЮ-кадра (frameRect), а не от исходного: у HD-плаща
  // кадр 2048×1024, а превью-кадр 256×128. Умножение исходного кадра на k дало
  // бы канвас 8192×4096 — 33 мегапикселя на карточку.
  const normalizedSize = () => {
    const aw = texture.kind.atlasWidth;
    const ah = aw === 64 ? ATLAS_H : aw === 22 ? 17 : 22;
    const k = Math.max(1, Math.round(frameRect(texture.geometry, texture.scale, 0).sw / aw));
    return { w: aw * k, h: ah * k };
  };

  function paintTo(canvas, index) {
    const g = texture.geometry;
    const src = frameRect(g, texture.scale, index);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(texture.canvas, src.sx, src.sy, src.sw, src.sh, 0, 0, canvas.width, canvas.height);
  }

  // Вьюер рисует меш по capeCanvas: подменяем кадр прямо в нём. Хвост и крылья
  // ссылаются на одну и ту же текстуру, поэтому одного dirty-флага хватает обоим.
  function paintViewer() {
    if (!viewer || !texture) return;
    const n = normalizedSize();
    const cc = viewer.capeCanvas;
    const src = frameRect(texture.geometry, texture.scale, frame);
    const ctx = cc.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cc.width, cc.height);
    // Не в весь cc, а в его верхний левый угол размером с нормализованный кадр:
    // у плаща без крыльев (22×17) capeCanvas всё равно 64×32, и растянуть кадр
    // на него значило бы размазать текстуру по пустому месту.
    ctx.drawImage(texture.canvas, src.sx, src.sy, src.sw, src.sh, 0, 0, n.w, n.h);
    const cape = viewer.playerObject && viewer.playerObject.cape;
    if (cape && cape.map) cape.map.needsUpdate = true;
  }

  function onContextLost() { container.classList.add('cape-failed'); }

  function releaseViewer() {
    if (!viewer) return;
    viewer.canvas.removeEventListener('webglcontextlost', onContextLost);
    viewer.dispose();
    // dispose() не отдаёт контекст обратно: без forceContextLoss он висит до
    // сборки мусора, и потолок в 16 контекстов выбирается насквозь.
    if (viewer.renderer && viewer.renderer.forceContextLoss) viewer.renderer.forceContextLoss();
    viewer = null;
    animViewers = Math.max(0, animViewers - 1);
    container.replaceChildren();
  }

  function mountViewer() {
    if (viewer || disposed || !texture || texture.atlasScale == null) return false;
    if (typeof skinview3d === 'undefined' || animViewers >= MAX_ANIM_VIEWERS) return false;
    let v = null;
    try {
      v = new skinview3d.SkinViewer({ width: size, height: size });
      v.background = 0x0d0b1a;
      v.autoRotate = true;
      v.zoom = 1.2;
      container.replaceChildren(v.canvas);
      v.canvas.addEventListener('webglcontextlost', onContextLost);
      v.loadSkin(null);
      const n = normalizedSize();
      const first = document.createElement('canvas');
      first.width = n.w;
      first.height = n.h;
      paintTo(first, frame);
      // loadCape заводит capeCanvas и натягивает текстуру и на хвост, и на
      // крылья. Дальше кадры подменяются в capeCanvas напрямую.
      v.loadCape(first, { backEquipment: mode });
      viewer = v;
      animViewers++;
      return true;
    } catch (e) {
      console.error('skinview3d init error:', e);
      if (v) {
        try {
          v.dispose();
          if (v.renderer && v.renderer.forceContextLoss) v.renderer.forceContextLoss();
        } catch (_) {}
      }
      return false;
    }
  }

  // Канвас ПЕРЕСОЗДАЁТСЯ при смене режима, а не просто перерисовывается:
  // хвост — это 10×16, а «хвост + крыло» — 21×20. Втиснуть композит в форму
  // хвоста — значит получить пустые поля сверху и снизу, то есть ровно тот вид,
  // который пользователь называет «текстурка не загрузилась».
  function drawFlat(m) {
    const canvas = previewCanvas(size, CAPE_MODES[m]);
    canvas.dataset.previewMode = m;
    flat.player.start(canvas.getContext('2d'), texture, CAPE_MODES[m]);
    container.replaceChildren(canvas);
    flat.canvas = canvas;
  }

  function mountFlat() {
    if (flat || disposed || !texture || texture.atlasScale == null) return;
    flat = { canvas: null, player: createFramePlayer(ANIM_FPS) };
    drawFlat(mode);
  }

  const applyMode = () => {
    if (disposed) return;
    if (viewer && viewer.playerObject) viewer.playerObject.backEquipment = mode;
    if (flat) drawFlat(mode);
  };

  // Клик по «Крылья» на плоской карточке обязан дать объёмные крылья: плоский
  // композит пользователь читает как «развёрнутая текстура вместо 3D», то есть
  // как поломку. Поэтому карточка поднимается в 3D по требованию, а слот
  // отбирается у самой давно показанной карточки с вьюером — у неё остаётся
  // плоский вариант, который не стоит ничего.
  const promote = () => {
    if (viewer || disposed || typeof skinview3d === 'undefined') return false;
    if (texture && texture.atlasScale == null) return false;
    if (animViewers >= MAX_ANIM_VIEWERS) {
      let victim = null;
      for (const [other, p] of animPreviews) {
        if (other === container || !p.hasViewer()) continue;
        if (!victim) victim = [other, p];
        else if (victim[1].isVisible() && !p.isVisible()) victim = [other, p];
        else if (victim[1].isVisible() === p.isVisible() && p.seen < victim[1].seen) victim = [other, p];
      }
      if (victim) victim[1].demote();
    }
    if (!mountViewer()) return false;
    if (flat) { flat.player.stop(); flat = null; }
    paintViewer();
    startTimer();
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

  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startTimer() {
    stopTimer();
    if (disposed || !texture || frameCount() <= 1) return;
    timer = setInterval(() => {
      if (disposed || !viewer) return;
      frame = (frame + 1) % frameCount();
      paintViewer();
    }, Math.max(16, Math.round(1000 / ANIM_FPS)));
  }

  // Разбор PNG откладываем до первой видимости: у сотни карточек это сотня
  // декодирований, которых до прокрутки можно не делать.
  const ensureLoaded = () => {
    if (texture || disposed) return Promise.resolve();
    if (loading) return loading;
    showLoading(container);
    loading = loadTexture(url).then(tex => {
      if (disposed) return;
      texture = tex;
      setElytraBadge(card, tex.verdict);
      setElytraToggle(card, tex.verdict);
    }).catch(e => {
      if (disposed) return;
      console.warn('Не удалось разобрать текстуру:', url, e);
      failBadge(card, 'не проверили');
      setElytraToggle(card, null);
      showUnreadable(container, url);
    });
    return loading;
  };

  return {
    async show() {
      setVisible(true);
      seen = ++viewSeq;
      await ensureLoaded();
      if (disposed || !texture) return;
      if (!viewer && mountViewer()) {
        // Место под WebGL освободилось — меняем плоскую анимацию на объёмную.
        if (flat) {
          flat.player.stop();
          flat = null;
        }
      } else if (!viewer && !flat) {
        mountFlat();
      }
      if (viewer) {
        paintViewer();
        startTimer();
      } else if (flat) {
        // hide() гасит и плоский проигрыватель тоже. Без перезапуска карточка,
        // вернувшаяся на экран, так и осталась бы замороженной на одном кадре.
        // from = текущий кадр: возврат не должен отматывать анимацию в начало.
        flat.player.start(flat.canvas.getContext('2d'), texture, CAPE_MODES[mode], flat.player.frame);
      }
    },
    hide() {
      setVisible(false);
      stopTimer();
      // 2D-канвас только останавливаем: он ничего не стоит и пусть держит
      // последний кадр. А WebGL-слот отпускается не сразу, а через
      // ANIM_OFFSCREEN_GRACE — мгновенный release превращал обычную прокрутку
      // в мельтешение 2D↔3D, о котором и жаловались.
      if (flat) flat.player.stop();
    },
    // Слот отдан другой карточке: вьюер освобождается, но превью остаётся
    // видимым — плоская анимация не стоит WebGL-контекста.
    demote() {
      if (disposed) return;
      stopTimer();
      if (flat) { flat.player.stop(); flat = null; }
      releaseViewer();
      if (texture) mountFlat();
    },
    hasViewer() { return Boolean(viewer); },
    isVisible() { return visible; },
    get seen() { return seen; },
    dispose() {
      if (disposed) return;
      disposed = true;
      card.removeEventListener('click', onClick);
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      stopTimer();
      if (flat) flat.player.stop();
      releaseViewer();
    },
  };
}

// Наблюдатель за карточками: видимость экономит CPU, а для 3D — единственный
// способ уложиться в потолок WebGL-контекстов.
let animObserver = null;

function observeAnimCards() {
  const grid = $('#skins-grid');
  if (!grid) return;

  const containers = Array.from(grid.querySelectorAll('.skin-canvas-container[data-skin]'));

  if (animObserver) {
    animObserver.disconnect();
    animObserver = null;
  }

  for (const container of containers) {
    if (animPreviews.has(container)) continue;
    const card = container.closest('.skin-card');
    if (!card) continue;
    const preview = initAnimPreview(card, 160);
    if (preview) animPreviews.set(container, preview);
  }

  if (typeof IntersectionObserver === 'undefined') {
    // Без наблюдателя показываем всё сразу: на серверном рендере или в старом
    // движке лучше картинка, чем пустые карточки.
    animPreviews.forEach(p => p.show());
    return;
  }

  animObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const preview = animPreviews.get(entry.target);
      if (!preview) continue;
      if (entry.isIntersecting) preview.show();
      else preview.hide();
    }
  }, { rootMargin: `${ANIM_OBSERVER_MARGIN}px 0px` });

  containers.forEach(c => animObserver.observe(c));
}

// Перерисовка сетки выбрасывает старые контейнеры вместе с таймерами —
// иначе после каждого поиска в памяти оставались бы мёртвые проигрыватели.
function disposeAnimPreviews() {
  if (animObserver) {
    animObserver.disconnect();
    animObserver = null;
  }
  animPreviews.forEach(p => p.dispose());
  animPreviews.clear();
}


// ─── Библиотека ───
function renderSkins() {
  disposeAnimPreviews();

  const grid = $('#skins-grid');
  const list = state.skins;
  const equippedId = state.equipped.animated?.id;

  if (list.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✨</div>
        <p>Анимированных плащей пока нет</p>
        <small>Добавьте первый Stacked PNG через «+ Добавить»</small>
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
            <span class="skin-category cape">Аним.</span>
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

  requestAnimationFrame(observeAnimCards);
}

async function loadSkins() {
  try {
    const params = new URLSearchParams();
    const searchVal = $('#search-input').value.trim();
    if (searchVal) params.set('search', searchVal);
    const data = await API.get(`${API_BASE}/skins?${params}`);
    state.skins = data.skins;
    renderSkins();
  } catch (e) {
    toast('Ошибка загрузки: ' + e.message, 'error');
  }
}

async function loadEquipped() {
  try {
    const data = await API.get(`${API_BASE}/equip`);
    state.equipped = data.equipped;
    renderEquipped();
  } catch (e) {
    toast('Ошибка загрузки экипировки: ' + e.message, 'error');
  }
}

// ─── Экипировка ───
//
// Слот экипировки — отдельный проигрыватель: тут нет тумблера и вердикта, но
// анимация должна крутиться так же. Держим хэндл модульно, чтобы сбрасывать
// его при каждой перерисовке слота, а не плодить таймеры.
let equipAnim = null;

function stopEquipAnim() {
  if (equipAnim) {
    equipAnim.stop();
    equipAnim = null;
  }
}

function mountEquipAnim(container, size) {
  let player = null;
  let stopped = false;

  loadTexture(container.dataset.skin).then(tex => {
    if (stopped) return;
    const canvas = previewCanvas(size, CAPE_FACE);
    container.replaceChildren(canvas);
    player = createFramePlayer();
    player.start(canvas.getContext('2d'), tex, CAPE_FACE);
  }).catch(e => {
    if (stopped) return;
    console.warn('Не удалось разобрать текстуру экипировки:', e);
    showUnreadable(container, container.dataset.skin);
  });

  return {
    stop() {
      stopped = true;
      if (player) player.stop();
    },
  };
}

function renderEquipped() {
  const slot = $('#equip-animated');
  const skin = state.equipped.animated;
  const clearBtn = $('.slot-clear[data-category="animated"]');

  stopEquipAnim();

  if (skin) {
    slot.innerHTML = `<div class="equip-container" data-skin="${skin.url}"></div>`;
    requestAnimationFrame(() => {
      const container = slot.querySelector('.equip-container');
      if (container) equipAnim = mountEquipAnim(container, 150);
    });
    if (clearBtn) clearBtn.classList.remove('hidden');
  } else {
    slot.innerHTML = `<span class="empty-slot">Пусто</span>`;
    if (clearBtn) clearBtn.classList.add('hidden');
  }
}

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
  disposeAnimPreviews();
  stopEquipAnim();
  state.user = null;
  state.skins = [];
  state.equipped = { animated: null };
  $('#navbar').classList.add('hidden');
  $('#view-auth').classList.remove('hidden');
  showView('auth');
  toast('Вы вышли', 'info');
});

// ─── Навигация ───
$$('.nav-link[data-view]').forEach(link => {
  link.addEventListener('click', () => {
    const view = link.dataset.view;
    if (view === 'equipped') { loadEquipped(); showView('equipped'); }
    else if (view === 'add') { resetForm(); showView('add'); }
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
  $('.drop-text').textContent = 'Перетащите Stacked PNG сюда';
  $('.drop-hint').textContent = 'или нажмите, чтобы выбрать файл';
  dropZone.classList.remove('has-file');
  $('#skin-submit').textContent = 'Сохранить';
  $('#skin-cancel').classList.add('hidden');
  $('#view-add .view-title').textContent = 'Добавить анимированный плащ';
  if (editData) {
    $('#skin-id').value = editData.id;
    $('#skin-name').value = editData.name;
    $('#skin-tags').value = editData.tags || '';
    $('#skin-submit').textContent = 'Обновить';
    $('#skin-cancel').classList.remove('hidden');
    $('#view-add .view-title').textContent = 'Редактировать анимированный плащ';
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
      await API.put(`${API_BASE}/skins/${id}`, { name, tags });
      toast('Анимированный плащ обновлён', 'success');
    } else {
      if (!selectedFile) {
        toast('Выберите Stacked PNG', 'error');
        return;
      }
      const form = new FormData();
      form.append('file', selectedFile);
      form.append('name', name);
      form.append('tags', tags);
      await API.postForm(`${API_BASE}/upload`, form);
      toast('Анимированный плащ добавлен', 'success');
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
      await API.post(`${API_BASE}/equip`, { skin_id: parseInt(id) });
      await Promise.all([loadSkins(), loadEquipped()]);
      toast('Экипировано', 'success');
    })().catch(e => toast(e.message, 'error')));
  } else if (btn.classList.contains('open-btn')) {
    const skin = state.skins.find(s => s.id == id);
    window.open(skin?.file || `${API_BASE}/skin-file/${id}.png`, '_blank');
  } else if (btn.classList.contains('edit-btn')) {
    const skin = state.skins.find(s => s.id == id);
    if (skin) { resetForm(skin); showView('add'); }
  } else if (btn.classList.contains('delete-btn')) {
    if (!confirm('Удалить этот анимированный плащ?')) return;
    await apiWithLoading(btn, (async () => {
      await API.del(`${API_BASE}/skins/${id}`);
      await Promise.all([loadSkins(), loadEquipped()]);
      toast('Анимированный плащ удалён', 'info');
    })().catch(e => toast(e.message, 'error')));
  }
});

// ─── Снять анимированный плащ ───
document.querySelectorAll('.slot-clear').forEach(btn => {
  btn.addEventListener('click', async () => {
    await apiWithLoading(btn, (async () => {
      await API.del(`${API_BASE}/equip`);
      await Promise.all([loadSkins(), loadEquipped()]);
      toast('Снято', 'info');
    })().catch(e => toast(e.message, 'error')));
  });
});

// ─── Init ───
loadUploadLimits();
checkAuth();

// Тестовые точки входа: страница подключает модуль как есть, глобалов больше
// нет, а браузерному тесту нужно самому поставить состояние и перерисовать
// сетку. Экспорт live-binding, поэтому состояние видно снаружи.
export { state, renderSkins, renderEquipped, showView };
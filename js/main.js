// Jambra — mural colaborativo
import { createSync, hasFirebase, rid } from './sync.js';
import * as Drive from './drive.js';

/* ================= utilidades ================= */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const round = (n, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function throttle(fn, ms) {
  let last = 0, timer = null, args;
  return (...a) => {
    args = a;
    const left = ms - (Date.now() - last);
    if (left <= 0) { clearTimeout(timer); timer = null; last = Date.now(); fn(...args); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, left);
  };
}

function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function download(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(href), 5000);
}

const fileName = () => (S.meta.title || 'Mural sem título').replace(/[\\/:*?"<>|]+/g, '-');

/* ================= constantes e estado ================= */

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const COLORS = ['#202124', '#1a73e8', '#188038', '#f9ab00', '#d93025', '#9334e6', '#ffffff'];
const HL_COLORS = ['#fff200', '#7cff6b', '#6be4ff', '#ff8ad8', '#ffb347'];
const STICKY = ['#fff475', '#ccff90', '#a7ffeb', '#aecbfa', '#fdcfe8', '#ffd8a8'];
const PEOPLE = ['#e8710a', '#1a73e8', '#188038', '#d93025', '#9334e6', '#12b5cb', '#e52592', '#b06000'];
const SHAPES = [['rect', 'Retângulo'], ['ellipse', 'Elipse'], ['line', 'Linha'], ['arrow', 'Seta']];
const TOOL_KEYS = { v: 'select', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser', n: 'sticky', t: 'text', s: 'shape' };
const ERASABLE = new Set(['stroke', 'rect', 'ellipse', 'line', 'arrow']);

const prefs = Object.assign({
  pen: { color: COLORS[0], width: 4 },
  hl: { color: HL_COLORS[0], width: 24 },
  stickyColor: STICKY[0],
  text: { color: COLORS[0], size: 32 },
  shape: { kind: 'rect', color: COLORS[1] },
}, store.get('jambra:prefs', {}));

const S = {
  roomId: null, token: null, sync: null,
  objects: new Map(), nodes: new Map(), meta: { pages: {} },
  page: null, tool: 'pen',
  busy: new Set(), before: null, editing: null, placeEditor: null,
  undo: [], redo: [], peers: new Map(),
  loading: false, fitted: true, framesOpen: store.get('jambra:frames', false),
  dirty: false, dirtyV: 0, saving: false, driveError: false, needAuth: false,
  me: {
    id: null,
    // nome escolhido pela pessoa; sem ele, aparece como "Visitante N" pela ordem de chegada
    custom: /^Visitante \d+$/.test(store.get('jambra:name') || '') ? null : store.get('jambra:name'),
    joined: 0,
    color: store.get('jambra:color') || PEOPLE[Math.floor(Math.random() * PEOPLE.length)],
  },
};
store.set('jambra:name', S.me.custom);
store.set('jambra:color', S.me.color);

/* ================= palco (Konva) ================= */

const boardEl = $('#board');
const stage = new Konva.Stage({ container: boardEl, width: boardEl.clientWidth || innerWidth, height: boardEl.clientHeight || innerHeight });
// Cada quadro é um slide de tamanho fixo 16:9, como no Jamboard.
// Murais novos usam o tamanho do Google Slides widescreen (960×540 px);
// murais criados antes guardam o tamanho antigo (1600×900) para nada sair do lugar.
const SLIDE_SIZE = { w: 960, h: 540 };
const LEGACY_SIZE = { w: 1600, h: 900 };
let PAGE_W = LEGACY_SIZE.w;
let PAGE_H = LEGACY_SIZE.h;
// Fator para tamanhos padrão (post-it, fonte, espessura), pensados para 1600 de largura.
const U = () => PAGE_W / 1600;
const inPage = (p) => p.x >= 0 && p.y >= 0 && p.x <= PAGE_W && p.y <= PAGE_H;

const layer = new Konva.Layer({ clip: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } });

function setPageSize(size) {
  const w = size?.w || LEGACY_SIZE.w, h = size?.h || LEGACY_SIZE.h;
  if (w === PAGE_W && h === PAGE_H) return;
  PAGE_W = w;
  PAGE_H = h;
  layer.clip({ x: 0, y: 0, width: w, height: h });
  thumbs.clear();
  fitView();
}
const ui = new Konva.Layer();
stage.add(layer);
stage.add(ui);

const tr = new Konva.Transformer({
  borderStroke: '#1a73e8', anchorStroke: '#1a73e8', anchorFill: '#fff', anchorSize: 10, anchorCornerRadius: 5,
  padding: 4, rotationSnaps: [0, 90, 180, 270], rotationSnapTolerance: 6, flipEnabled: false,
});
ui.add(tr);
const band = new Konva.Rect({ fill: 'rgba(26,115,232,0.08)', stroke: '#1a73e8', strokeWidth: 1, strokeScaleEnabled: false, visible: false, listening: false });
ui.add(band);

// A "folha" branca do slide fica atrás do canvas, com o padrão de fundo em CSS.
const paperEl = document.createElement('div');
paperEl.id = 'paper';
boardEl.prepend(paperEl);

new ResizeObserver(() => {
  stage.size({ width: boardEl.clientWidth, height: boardEl.clientHeight });
  if (S.fitted || stage.scaleX() < minScale()) fitView();
  else setView(stage.x(), stage.y(), stage.scaleX());
}).observe(boardEl);

const screenPt = (e) => { const r = boardEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const worldPt = (p) => ({ x: (p.x - stage.x()) / stage.scaleX(), y: (p.y - stage.y()) / stage.scaleY() });
const viewCenter = () => {
  const c = worldPt({ x: stage.width() / 2, y: stage.height() / 2 });
  return { x: clamp(c.x, 0, PAGE_W), y: clamp(c.y, 0, PAGE_H) };
};
const visibleNodes = () => [...S.nodes.values()].filter((n) => n.visible());
const selectableNodes = () => visibleNodes().filter((n) => n.getAttr('otype') !== 'background');

/* ---------- visualização ---------- */

// Área livre para o slide (descontando a barra de ferramentas e o zoom).
function area() {
  const W = stage.width(), H = stage.height();
  const m = W < 760 ? { l: 12, r: 12, t: 12, b: 76 } : { l: 80, r: 24, t: 24, b: 64 };
  return { l: m.l, t: m.t, w: Math.max(100, W - m.l - m.r), h: Math.max(100, H - m.t - m.b) };
}
const minScale = () => { const a = area(); return Math.min(a.w / PAGE_W, a.h / PAGE_H); };

// Menor que a área: centraliza. Maior: não deixa a borda do slide entrar na área.
function clampAxis(pos, size, start, len) {
  return size <= len ? start + (len - size) / 2 : clamp(pos, start + len - size, start);
}

function setView(x, y, s) {
  const a = area();
  s = Math.max(s, minScale());
  x = clampAxis(x, PAGE_W * s, a.l, a.w);
  y = clampAxis(y, PAGE_H * s, a.t, a.h);
  stage.position({ x, y });
  stage.scale({ x: s, y: s });
  $('#zoom-label').textContent = Math.round((s / minScale()) * 100) + '%';
  updateBg();
  updateCursors();
  positionSelbar();
  S.placeEditor?.();
}

function zoomAt(p, factor) {
  const s0 = stage.scaleX();
  const s = clamp(s0 * factor, minScale(), 8);
  S.fitted = false;
  const wx = (p.x - stage.x()) / s0, wy = (p.y - stage.y()) / s0;
  setView(p.x - wx * s, p.y - wy * s, s);
}
const zoomCenter = (f) => zoomAt({ x: stage.width() / 2, y: stage.height() / 2 }, f);

function fitView() {
  setView(0, 0, minScale());
  S.fitted = true;
}

function updateBg() {
  const s = stage.scaleX();
  Object.assign(paperEl.style, { left: stage.x() + 'px', top: stage.y() + 'px', width: PAGE_W * s + 'px', height: PAGE_H * s + 'px' });
}

/* ================= objetos ================= */

function createNode(o) {
  switch (o.type) {
    case 'stroke':
    case 'line': return new Konva.Line({ lineCap: 'round', lineJoin: 'round', perfectDrawEnabled: false });
    case 'arrow': return new Konva.Arrow({ lineCap: 'round', lineJoin: 'round', perfectDrawEnabled: false });
    case 'rect': return new Konva.Rect({ cornerRadius: 4, perfectDrawEnabled: false });
    case 'ellipse': return new Konva.Ellipse({ perfectDrawEnabled: false });
    case 'text': return new Konva.Text({ fontFamily: FONT, lineHeight: 1.25 });
    case 'image': return new Konva.Image({});
    case 'background': return new Konva.Image({ listening: false });
    case 'sticky': {
      const g = new Konva.Group();
      g.add(new Konva.Rect({ name: 'bg', cornerRadius: 2, shadowColor: '#000', shadowOpacity: 0.18, shadowBlur: 10, shadowOffsetY: 3 }));
      g.add(new Konva.Text({ name: 'txt', fontFamily: FONT, align: 'center', verticalAlign: 'middle', lineHeight: 1.2, fill: '#202124', listening: false }));
      return g;
    }
    default: return new Konva.Group();
  }
}

// Post-it: diminui a fonte até o texto caber.
const stickyPad = (w) => round(w * 0.07);

function fitText(t, w, h) {
  t.setAttrs({ width: w, height: 'auto', padding: stickyPad(w) });
  const step = w / 100;
  let fs = w * 0.15;
  t.fontSize(fs);
  while (fs > w * 0.05 && t.height() > h) t.fontSize((fs -= step));
  t.height(h);
}

function updateNode(n, o) {
  n.setAttrs({ x: o.x || 0, y: o.y || 0, rotation: o.rotation || 0, scaleX: o.scaleX || 1, scaleY: o.scaleY || 1 });
  const sw = o.sw || 4 * U();
  const fill = o.fill || 'rgba(0,0,0,0)'; // preenchimento invisível para dar para clicar dentro
  switch (o.type) {
    case 'stroke':
      n.setAttrs({
        points: o.points || [], stroke: o.color, strokeWidth: o.width || 4, hitStrokeWidth: Math.max(o.width || 4, 14),
        opacity: o.hl ? 0.45 : 1, globalCompositeOperation: o.hl ? 'multiply' : 'source-over',
      });
      break;
    case 'line':
    case 'arrow':
      n.setAttrs({ points: o.points || [0, 0, 0, 0], stroke: o.color, fill: o.color, strokeWidth: sw, hitStrokeWidth: 18 });
      if (o.type === 'arrow') n.setAttrs({ pointerLength: sw * 4, pointerWidth: sw * 4 });
      break;
    case 'rect':
      n.setAttrs({ width: o.w, height: o.h, stroke: o.color, strokeWidth: sw, fill });
      break;
    case 'ellipse':
      n.setAttrs({ radiusX: o.w / 2, radiusY: o.h / 2, offsetX: -o.w / 2, offsetY: -o.h / 2, stroke: o.color, strokeWidth: sw, fill });
      break;
    case 'text':
      n.setAttrs({ text: o.text || '', fontSize: o.fs || 32 * U(), fill: o.color, width: o.w || 'auto' });
      break;
    case 'sticky': {
      n.findOne('.bg').setAttrs({ width: o.w, height: o.h, fill: o.color });
      const t = n.findOne('.txt');
      t.text(o.text || '');
      fitText(t, o.w, o.h);
      break;
    }
    case 'image':
    case 'background':
      n.setAttrs({ width: o.w, height: o.h });
      if (n.getAttr('src') !== o.src) {
        n.setAttr('src', o.src);
        const img = new Image();
        img.onload = () => { if (n.getAttr('src') === o.src) { n.image(img); layer.batchDraw(); markPage(o.page); } };
        img.src = o.src;
      }
      break;
  }
}

function renderObject(id, o) {
  let n = S.nodes.get(id);
  if (n && n.getAttr('otype') !== o.type) { destroyNode(id); n = null; }
  if (!n) {
    n = createNode(o);
    n.setAttrs({ oid: id, otype: o.type, name: 'obj' });
    S.nodes.set(id, n);
    layer.add(n);
  }
  updateNode(n, o);
  n.visible(o.page === S.page);
  n.draggable(S.tool === 'select' && o.type !== 'background');
  if (n.getAttr('z') !== o.z) { n.setAttr('z', o.z); scheduleSort(); }
  if (tr.nodes().includes(n)) { tr.forceUpdate(); positionSelbar(); }
  layer.batchDraw();
}

let sortPending = false;
function scheduleSort() {
  if (sortPending) return;
  sortPending = true;
  requestAnimationFrame(() => {
    sortPending = false;
    layer.getChildren().slice()
      .sort((a, b) => (a.getAttr('z') || 0) - (b.getAttr('z') || 0))
      .forEach((n, i) => n.zIndex(i));
    layer.batchDraw();
  });
}

function destroyNode(id) {
  const n = S.nodes.get(id);
  if (!n) return;
  if (tr.nodes().includes(n)) select(tr.nodes().filter((x) => x !== n));
  n.destroy();
  S.nodes.delete(id);
  layer.batchDraw();
}

// Chamado pela sincronização (inclusive para as próprias escritas).
function applyObject(id, o) {
  if (o && !o.type) { S.sync?.removeObject(id); return; } // atualização parcial de algo já apagado
  const old = S.objects.get(id);
  if (!o) {
    if (old || S.nodes.has(id)) { S.objects.delete(id); destroyNode(id); markDirty(); markPage(old?.page); }
    return;
  }
  S.objects.set(id, o);
  markDirty();
  markPage(o.page);
  if (old && old.page !== o.page) markPage(old.page);
  if (!S.busy.has(id)) renderObject(id, o);
}

function putObject(id, o) {
  applyObject(id, o);
  S.sync.setObject(id, o);
}

function patch(id, p) {
  const cur = S.objects.get(id);
  if (!cur) return;
  const o = { ...cur, ...p };
  for (const k in o) if (o[k] == null) delete o[k];
  S.objects.set(id, o);
  if (!S.busy.has(id)) renderObject(id, o);
  S.sync.updateObject(id, p);
  markDirty();
  markPage(o.page);
}

function deleteObject(id) {
  markPage(S.objects.get(id)?.page);
  S.objects.delete(id);
  destroyNode(id);
  S.sync.removeObject(id);
  markDirty();
}

const newObj = (type, props) => ({ type, page: S.page, z: Date.now() + Math.random(), by: myName(), x: 0, y: 0, ...props });

const geom = (n) => ({
  x: round(n.x()), y: round(n.y()), rotation: round(n.rotation(), 2),
  scaleX: round(n.scaleX(), 3), scaleY: round(n.scaleY(), 3),
});

function objNode(shape) {
  if (!shape || shape.getLayer() !== layer) return null;
  for (let n = shape; n && n !== layer; n = n.getParent()) if (n.getAttr('oid')) return n;
  return null;
}

/* ================= histórico (desfazer/refazer) ================= */

function pushHistory(entries) {
  entries = entries.filter((e) => JSON.stringify(e.before) !== JSON.stringify(e.after));
  if (!entries.length) return;
  S.undo.push(entries);
  if (S.undo.length > 150) S.undo.shift();
  S.redo.length = 0;
  updateUndo();
}

function applyEntries(entries, key) {
  select([]);
  for (const e of entries) {
    const v = e[key];
    if (v) putObject(e.id, clone(v));
    else if (S.objects.has(e.id)) deleteObject(e.id);
  }
  const page = entries.find((e) => e[key])?.[key].page;
  if (page && page !== S.page && S.meta.pages?.[page]) goPage(page);
}

function undo() { const e = S.undo.pop(); if (!e) return; applyEntries(e, 'before'); S.redo.push(e); updateUndo(); }
function redo() { const e = S.redo.pop(); if (!e) return; applyEntries(e, 'after'); S.undo.push(e); updateUndo(); }
function updateUndo() {
  $('#btn-undo').disabled = !S.undo.length;
  $('#btn-redo').disabled = !S.redo.length;
}

/* ================= seleção ================= */

const selectedIds = () => tr.nodes().map((n) => n.getAttr('oid')).filter((id) => S.objects.has(id));
const selectedObjs = () => selectedIds().map((id) => S.objects.get(id));

function select(nodes) {
  nodes = nodes.filter((n) => n && n.getStage());
  tr.nodes(nodes);
  const one = nodes.length === 1 && S.objects.get(nodes[0].getAttr('oid'));
  tr.enabledAnchors(one && (one.type === 'text' || one.type === 'sticky' || one.type === 'image')
    ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
    : ['top-left', 'top-center', 'top-right', 'middle-right', 'middle-left', 'bottom-left', 'bottom-center', 'bottom-right']);
  ui.batchDraw();
  renderSelbar();
}

const iconBtn = (a, title) => `<button class="icon-btn" data-sel="${a}" title="${title}"><svg><use href="#i-${a}"/></svg></button>`;

function renderSelbar() {
  const bar = $('#selbar');
  const objs = selectedObjs();
  if (!objs.length || S.editing) { bar.hidden = true; return; }
  const allSticky = objs.every((o) => o.type === 'sticky');
  const palette = allSticky ? STICKY : COLORS;
  const colorable = objs.some((o) => o.type !== 'image');
  const fillable = objs.some((o) => o.type === 'rect' || o.type === 'ellipse');
  const editable = objs.length === 1 && (objs[0].type === 'sticky' || objs[0].type === 'text');
  bar.innerHTML = [
    colorable ? palette.map((c) => `<button class="sw${allSticky ? ' sq' : ''}" data-color="${c}" style="--c:${c}" title="Cor"></button>`).join('') : '',
    fillable ? iconBtn('fill', 'Preenchimento') : '',
    editable ? iconBtn('edit', 'Editar texto (Enter)') : '',
    colorable || fillable || editable ? '<span class="sep"></span>' : '',
    iconBtn('front', 'Trazer para frente'),
    iconBtn('back', 'Enviar para trás'),
    iconBtn('dup', 'Duplicar (Ctrl+D)'),
    iconBtn('del', 'Excluir (Delete)'),
  ].join('');
  bar.hidden = false;
  positionSelbar();
}

function positionSelbar() {
  const bar = $('#selbar');
  if (bar.hidden || !tr.nodes().length) return;
  const r = tr.getClientRect();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = r.y - bh - 14;
  if (top < 8) top = r.y + r.height + 14;
  top = clamp(top, 8, stage.height() - bh - 8);
  const left = clamp(r.x + r.width / 2 - bw / 2, 8, Math.max(8, stage.width() - bw - 8));
  bar.style.transform = `translate(${left}px, ${top}px)`;
}

// Aplica uma alteração a cada objeto selecionado, com histórico.
function change(fn) {
  const entries = [];
  for (const id of selectedIds()) {
    const o = S.objects.get(id);
    const p = fn(o);
    if (!p) continue;
    const before = clone(o);
    patch(id, p);
    entries.push({ id, before, after: clone(S.objects.get(id)) });
  }
  pushHistory(entries);
  renderSelbar();
}

const recolor = (c) => change((o) => {
  if (o.type === 'image' || (o.type === 'sticky' && !STICKY.includes(c))) return null;
  return { color: c, ...(o.fill ? { fill: c + '33' } : {}) };
});

function toggleFill() {
  const on = !selectedObjs().some((o) => o.fill);
  change((o) => (o.type === 'rect' || o.type === 'ellipse' ? { fill: on ? o.color + '33' : null } : null));
}

function restack(dir) {
  const zs = [...S.objects.values()].filter((o) => o.page === S.page).map((o) => o.z || 0);
  const base = dir > 0 ? Math.max(...zs) : Math.min(...zs);
  let i = 0;
  change(() => ({ z: base + dir * ++i }));
}

function deleteSelection() {
  const entries = selectedIds().map((id) => ({ id, before: clone(S.objects.get(id)), after: null }));
  select([]);
  entries.forEach((e) => deleteObject(e.id));
  pushHistory(entries);
}

function duplicate(objs = selectedObjs(), offset = 24 * U()) {
  if (!objs.length) return;
  const now = Date.now();
  const ids = objs.map((o, i) => {
    const id = rid();
    putObject(id, { ...clone(o), x: (o.x || 0) + offset, y: (o.y || 0) + offset, page: S.page, z: now + i, by: myName() });
    return id;
  });
  pushHistory(ids.map((id) => ({ id, before: null, after: clone(S.objects.get(id)) })));
  setTool('select');
  select(ids.map((id) => S.nodes.get(id)));
}

$('#selbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.color) return recolor(b.dataset.color);
  ({
    fill: toggleFill,
    edit: () => editText(selectedIds()[0]),
    front: () => restack(1),
    back: () => restack(-1),
    dup: () => duplicate(),
    del: deleteSelection,
  })[b.dataset.sel]?.();
});

/* ---------- arrastar e transformar (Konva) ---------- */

function beginEdit(nodes) {
  S.before = {};
  for (const n of nodes) {
    const id = n.getAttr('oid');
    S.before[id] = clone(S.objects.get(id));
    S.busy.add(id);
  }
  $('#selbar').hidden = true;
}

const sendLive = throttle(() => {
  for (const n of tr.nodes()) {
    const id = n.getAttr('oid');
    if (S.objects.has(id)) S.sync.updateObject(id, geom(n));
  }
}, 60);

function endEdit() {
  if (!S.before) return;
  const entries = [];
  for (const n of tr.nodes()) {
    const id = n.getAttr('oid');
    const before = S.before[id];
    S.busy.delete(id);
    if (!before || !S.objects.has(id)) continue;
    patch(id, geom(n));
    entries.push({ id, before, after: clone(S.objects.get(id)) });
  }
  for (const id of Object.keys(S.before)) S.busy.delete(id);
  S.before = null;
  pushHistory(entries);
  renderSelbar();
}

layer.on('dragstart', (e) => {
  const n = objNode(e.target);
  if (!n) return;
  if (!tr.nodes().includes(n)) select([n]);
  beginEdit(tr.nodes());
});
layer.on('dragmove', () => sendLive());
layer.on('dragend', () => endEdit());
tr.on('transformstart', () => beginEdit(tr.nodes()));
tr.on('transform', () => sendLive());
tr.on('transformend', () => endEdit());

stage.on('dblclick dbltap', (e) => {
  if (S.tool !== 'select') return;
  const n = objNode(e.target);
  const o = n && S.objects.get(n.getAttr('oid'));
  if (o && (o.type === 'sticky' || o.type === 'text')) editText(n.getAttr('oid'));
});

/* ================= edição de texto ================= */

function editText(id, isNew = false) {
  const n = S.nodes.get(id), o = S.objects.get(id);
  if (!n || !o) return;
  select([]);
  S.editing = id;
  S.busy.add(id);
  const before = clone(o);
  const sticky = o.type === 'sticky';
  const tnode = sticky ? n.findOne('.txt') : n;
  const ta = document.createElement('textarea');
  ta.className = 'editor ' + (sticky ? 'sticky' : 'text');
  ta.value = o.text || '';
  if (!sticky && !o.w) ta.wrap = 'off';
  document.body.appendChild(ta);
  tnode.hide();
  layer.batchDraw();

  const place = () => {
    const cur = S.objects.get(id) || o;
    const br = boardEl.getBoundingClientRect();
    const p = n.absolutePosition();
    const sc = n.getAbsoluteScale();
    let dy = 0;
    if (sticky) {
      ta.style.fontSize = tnode.fontSize() + 'px';
      ta.style.padding = `0 ${stickyPad(cur.w)}px`;
      ta.style.width = cur.w + 'px';
      ta.style.height = 'auto';
      const h = Math.min(cur.h, ta.scrollHeight);
      ta.style.height = h + 'px';
      dy = (cur.h - h) / 2;
    } else {
      const fs = cur.fs || 32 * U();
      tnode.text(ta.value || ' ');
      ta.style.fontSize = fs + 'px';
      ta.style.color = cur.color;
      ta.style.width = (cur.w || tnode.width() + fs) + 'px';
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }
    Object.assign(ta.style, {
      left: br.left + p.x + 'px',
      top: br.top + p.y + 'px',
      transform: `rotate(${n.getAbsoluteRotation()}deg) scale(${sc.x}, ${sc.y}) translateY(${dy}px)`,
    });
  };
  S.placeEditor = place;

  const sendText = throttle(() => { if (S.objects.has(id)) S.sync.updateObject(id, { text: ta.value }); }, 300);
  ta.addEventListener('input', () => {
    if (sticky) { tnode.text(ta.value); fitText(tnode, o.w, o.h); }
    place();
    sendText();
  });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    ta.remove();
    S.busy.delete(id);
    S.editing = null;
    S.placeEditor = null;
    tnode.show();
    if (!S.objects.has(id)) { layer.batchDraw(); return; } // apagado por outra pessoa
    const text = ta.value.replace(/\s+$/, '');
    if (o.type === 'text' && !text.trim()) {
      deleteObject(id);
      if (!isNew) pushHistory([{ id, before, after: null }]);
      return;
    }
    patch(id, { text });
    renderObject(id, S.objects.get(id));
    pushHistory([{ id, before: isNew ? null : before, after: clone(S.objects.get(id)) }]);
    if (S.tool === 'select') select([n]);
  };
  ta.addEventListener('blur', finish);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); ta.blur(); }
  });
  place();
  ta.focus();
  ta.select();
}

function createSticky(wp) {
  const id = rid();
  const size = round(200 * U());
  const x = clamp(wp.x - size / 2, 0, PAGE_W - size), y = clamp(wp.y - size / 2, 0, PAGE_H - size);
  putObject(id, newObj('sticky', { x: round(x), y: round(y), w: size, h: size, color: prefs.stickyColor, text: '' }));
  setTool('select');
  editText(id, true);
}

function createText(wp, text = '') {
  const id = rid();
  const fs = round(prefs.text.size * U());
  putObject(id, newObj('text', { x: round(wp.x), y: round(wp.y - fs * 0.6), text, color: prefs.text.color, fs }));
  setTool('select');
  if (text) {
    pushHistory([{ id, before: null, after: clone(S.objects.get(id)) }]);
    select([S.nodes.get(id)]);
  } else editText(id, true);
}

/* ================= ponteiro: ferramentas e gestos ================= */

const pointers = new Map();
let pinch = null;
let gesture = null;
let spaceDown = false;

// Rastreamento de toques para zoom/movimento com dois dedos.
boardEl.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) startPinch();
}, true);
boardEl.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) movePinch();
}, true);
const dropPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
addEventListener('pointerup', dropPointer, true);
addEventListener('pointercancel', dropPointer, true);

function startPinch() {
  cancelGesture();
  S.nodes.forEach((n) => n.isDragging() && n.stopDrag());
  const [a, b] = [...pointers.values()];
  pinch = {
    d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    x: stage.x(), y: stage.y(), s: stage.scaleX(),
  };
  S.fitted = false;
}

function movePinch() {
  const [a, b] = [...pointers.values()];
  const r = boardEl.getBoundingClientRect();
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const s = clamp((pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, 0.1, 8);
  const wx = (pinch.c.x - r.left - pinch.x) / pinch.s;
  const wy = (pinch.c.y - r.top - pinch.y) / pinch.s;
  setView(c.x - r.left - wx * s, c.y - r.top - wy * s, s);
}

function cancelGesture() {
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.kind === 'draw' || g.kind === 'shape') { S.busy.delete(g.id); deleteObject(g.id); }
  else if (g.kind === 'erase') pushHistory(g.removed);
  else if (g.kind === 'band') { band.visible(false); ui.batchDraw(); }
  boardEl.classList.remove('grabbing');
}

const capture = (e) => { try { boardEl.setPointerCapture(e.pointerId); } catch {} };

boardEl.addEventListener('pointerdown', (e) => {
  if (!S.roomId || !S.sync) return;
  if (S.editing) document.activeElement?.blur();
  closePopups();
  if (pinch || pointers.size > 1) return;
  const sp = screenPt(e), wp = worldPt(sp);

  if (e.button === 1 || e.button === 2 || spaceDown || S.tool === 'hand') {
    gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: stage.x(), vy: stage.y() };
    boardEl.classList.add('grabbing');
    capture(e);
    return;
  }
  if (e.button !== 0) return;
  if (S.tool !== 'select' && S.tool !== 'eraser' && !inPage(wp)) return; // fora do slide

  switch (S.tool) {
    case 'select': return downSelect(e, sp, wp);
    case 'pen':
    case 'highlighter': return startStroke(e, wp);
    case 'eraser':
      gesture = { kind: 'erase', last: sp, removed: [] };
      eraseAt(sp);
      capture(e);
      return;
    case 'sticky': e.preventDefault(); return createSticky(wp);
    case 'text': e.preventDefault(); return createText(wp);
    case 'shape': return startShape(e, wp);
  }
});

function downSelect(e, sp, wp) {
  const hit = stage.getIntersection(sp);
  if (hit && hit.getLayer() === ui) return; // alças do transformer
  const n = objNode(hit);
  if (n) {
    const sel = tr.nodes();
    if (e.shiftKey) select(sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]);
    else if (!sel.includes(n)) select([n]);
    return; // o Konva cuida do arraste
  }
  if (!e.shiftKey) select([]);
  if (e.pointerType === 'touch') {
    // no toque, arrastar no vazio move a tela
    gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: stage.x(), vy: stage.y() };
  } else {
    gesture = { kind: 'band', x0: wp.x, y0: wp.y, base: e.shiftKey ? tr.nodes() : [] };
    band.setAttrs({ x: wp.x, y: wp.y, width: 0, height: 0, visible: true });
  }
  capture(e);
}

/* ---------- caneta e marca-texto ---------- */

const sendPoints = throttle((id, pts) => { if (S.objects.has(id)) S.sync.updateObject(id, { points: pts }); }, 100);

function startStroke(e, wp) {
  const hl = S.tool === 'highlighter';
  const st = hl ? prefs.hl : prefs.pen;
  const id = rid();
  const x = round(wp.x), y = round(wp.y);
  putObject(id, newObj('stroke', { points: [x, y, x, y], color: st.color, width: round(st.width * U(), 2), ...(hl ? { hl: 1 } : {}) }));
  S.busy.add(id);
  gesture = { kind: 'draw', id, pts: [x, y], node: S.nodes.get(id) };
  capture(e);
}

function addPoint(g, wp) {
  const n = g.pts.length;
  if (Math.hypot(wp.x - g.pts[n - 2], wp.y - g.pts[n - 1]) * stage.scaleX() < 2) return;
  g.pts.push(round(wp.x), round(wp.y));
  g.node.points(g.pts);
  layer.batchDraw();
  sendPoints(g.id, g.pts);
}

// Suaviza levemente o traço (média ponderada com os vizinhos).
function smooth(p) {
  if (p.length < 8) return p;
  const o = [p[0], p[1]];
  for (let i = 2; i < p.length - 2; i += 2) {
    o.push(round((p[i - 2] + 2 * p[i] + p[i + 2]) / 4), round((p[i - 1] + 2 * p[i + 1] + p[i + 3]) / 4));
  }
  o.push(p[p.length - 2], p[p.length - 1]);
  return o;
}

function endStroke(g) {
  const pts = g.pts.length === 2 ? [...g.pts, ...g.pts] : smooth(g.pts);
  S.busy.delete(g.id);
  patch(g.id, { points: pts });
  pushHistory([{ id: g.id, before: null, after: clone(S.objects.get(g.id)) }]);
}

/* ---------- borracha ---------- */

function eraseAt(sp) {
  const r = 6;
  for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
    const n = objNode(stage.getIntersection({ x: sp.x + dx, y: sp.y + dy }));
    if (!n) continue;
    const id = n.getAttr('oid');
    const o = S.objects.get(id);
    if (!o || !ERASABLE.has(o.type)) continue;
    gesture.removed.push({ id, before: clone(o), after: null });
    deleteObject(id);
  }
}

function clearPage() {
  const ids = [...S.objects].filter(([, o]) => o.page === S.page).map(([id]) => id);
  if (!ids.length || !confirm('Apagar tudo deste quadro?')) return;
  select([]);
  pushHistory(ids.map((id) => ({ id, before: clone(S.objects.get(id)), after: null })));
  ids.forEach(deleteObject);
}

/* ---------- formas ---------- */

const sendShape = throttle((id, p) => { if (S.objects.has(id)) S.sync.updateObject(id, p); }, 80);

function startShape(e, wp) {
  const id = rid();
  const k = prefs.shape.kind;
  const base = { x: round(wp.x), y: round(wp.y), color: prefs.shape.color, sw: round(4 * U(), 2) };
  putObject(id, newObj(k, k === 'line' || k === 'arrow' ? { ...base, points: [0, 0, 0, 0] } : { ...base, w: 1, h: 1 }));
  S.busy.add(id);
  gesture = { kind: 'shape', id, k, x0: wp.x, y0: wp.y, p: null };
  capture(e);
}

function moveShape(g, wp, constrain) {
  let dx = wp.x - g.x0, dy = wp.y - g.y0;
  let p;
  if (g.k === 'line' || g.k === 'arrow') {
    if (constrain) {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      dx = Math.cos(a) * len;
      dy = Math.sin(a) * len;
    }
    p = { points: [0, 0, round(dx), round(dy)] };
  } else {
    if (constrain) {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
    p = { x: round(Math.min(g.x0, g.x0 + dx)), y: round(Math.min(g.y0, g.y0 + dy)), w: round(Math.abs(dx)), h: round(Math.abs(dy)) };
  }
  g.p = p;
  updateNode(S.nodes.get(g.id), { ...S.objects.get(g.id), ...p });
  layer.batchDraw();
  sendShape(g.id, p);
}

function endShape(g) {
  const s = stage.scaleX();
  let p = g.p;
  const tiny = !p || (p.points ? Math.hypot(p.points[2], p.points[3]) * s < 8 : p.w * s < 8 && p.h * s < 8);
  if (tiny) {
    const u = U();
    p = g.k === 'line' || g.k === 'arrow'
      ? { points: [0, 0, round(160 * u), 0] }
      : { x: round(g.x0 - 80 * u), y: round(g.y0 - 55 * u), w: round(160 * u), h: round(110 * u) };
  }
  S.busy.delete(g.id);
  patch(g.id, p);
  pushHistory([{ id: g.id, before: null, after: clone(S.objects.get(g.id)) }]);
  setTool('select');
  select([S.nodes.get(g.id)]);
}

/* ---------- movimento e fim do gesto ---------- */

const sendCursor = throttle((wp) => sendPresence({ x: round(wp.x), y: round(wp.y) }), 60);

boardEl.addEventListener('pointermove', (e) => {
  if (!S.roomId || !S.sync) return;
  const sp = screenPt(e), wp = worldPt(sp);
  if (e.pointerType !== 'touch') sendCursor(wp);
  const g = gesture;
  if (!g || pinch) return;
  if (g.kind === 'pan') {
    setView(g.vx + e.clientX - g.sx, g.vy + e.clientY - g.sy, stage.scaleX());
  } else if (g.kind === 'draw') {
    const evs = e.getCoalescedEvents?.() || [];
    for (const ev of evs.length ? evs : [e]) addPoint(g, worldPt(screenPt(ev)));
  } else if (g.kind === 'erase') {
    const steps = Math.ceil(Math.hypot(sp.x - g.last.x, sp.y - g.last.y) / 5);
    for (let i = 1; i <= steps; i++) {
      eraseAt({ x: g.last.x + ((sp.x - g.last.x) * i) / steps, y: g.last.y + ((sp.y - g.last.y) * i) / steps });
    }
    g.last = sp;
  } else if (g.kind === 'shape') {
    moveShape(g, wp, e.shiftKey);
  } else if (g.kind === 'band') {
    band.setAttrs({ x: Math.min(g.x0, wp.x), y: Math.min(g.y0, wp.y), width: Math.abs(wp.x - g.x0), height: Math.abs(wp.y - g.y0) });
    ui.batchDraw();
  }
});

function onUp() {
  const g = gesture;
  gesture = null;
  if (!g) return;
  boardEl.classList.remove('grabbing');
  if (g.kind === 'draw') endStroke(g);
  else if (g.kind === 'erase') pushHistory(g.removed);
  else if (g.kind === 'shape') endShape(g);
  else if (g.kind === 'band') {
    const r = band.getClientRect();
    band.visible(false);
    const hits = r.width + r.height > 4 ? selectableNodes().filter((n) => Konva.Util.haveIntersection(r, n.getClientRect())) : [];
    select([...new Set([...g.base, ...hits])]);
  }
}
boardEl.addEventListener('pointerup', onUp);
boardEl.addEventListener('pointercancel', onUp);
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

boardEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!S.roomId) return;
  const k = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey || e.metaKey) zoomAt(screenPt(e), Math.exp(-clamp(e.deltaY * k, -40, 40) * 0.01));
  else setView(stage.x() - e.deltaX * k, stage.y() - e.deltaY * k, stage.scaleX());
}, { passive: false });

/* ================= imagens ================= */

const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// Reduz imagens grandes para não pesar na sincronização.
// Prints e desenhos (PNG) ficam em PNG para o texto não borrar; fotos viram JPEG.
// Só volta para JPEG se o PNG ficar pesado demais para sincronizar.
function encodeCanvas(c, preferPng, maxPng = 4_000_000) {
  if (preferPng) {
    const png = c.toDataURL('image/png');
    if (png.length < maxPng) return png;
  }
  return c.toDataURL('image/jpeg', 0.92);
}

// Reduz só imagens muito grandes (acima de 2560 px) para não pesar na sincronização.
async function compressImage(file) {
  const url = await readFile(file);
  const img = await loadImg(url);
  const sc = Math.min(1, 2560 / Math.max(img.width, img.height));
  if (sc === 1 && file.size < 2_000_000) return url;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * sc);
  c.height = Math.round(img.height * sc);
  const ctx = c.getContext('2d');
  const png = file.type === 'image/png';
  if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return encodeCanvas(c, png);
}

async function addImageFile(file, at) {
  if (!file?.type.startsWith('image/') || !S.sync) return;
  try {
    const src = await compressImage(file);
    const img = await loadImg(src);
    const sc = Math.min(1, (PAGE_W * 0.6) / img.width, (PAGE_H * 0.6) / img.height);
    const w = round(img.width * sc), h = round(img.height * sc);
    const c = at && inPage(at) ? at : viewCenter();
    const id = rid();
    putObject(id, newObj('image', { x: round(c.x - w / 2), y: round(c.y - h / 2), w, h, src }));
    pushHistory([{ id, before: null, after: clone(S.objects.get(id)) }]);
    setTool('select');
    select([S.nodes.get(id)]);
  } catch (e) {
    console.error(e);
    toast('Não foi possível abrir essa imagem.');
  }
}

/* ---------- imagem de fundo do quadro ---------- */

const pageBackgrounds = (pid = S.page) =>
  [...S.objects].filter(([, o]) => o.page === pid && o.type === 'background').map(([id]) => id);

// Ajusta a imagem ao slide: se já for quase 16:9, preenche (corta um pouco);
// senão mostra inteira, centralizada sobre branco.
function fitToSlide(w, h, W, H) {
  const cover = Math.abs(w / h / (W / H) - 1) < 0.15;
  const sc = cover ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  return { sc, x: (W - w * sc) / 2, y: (H - h * sc) / 2, cover };
}

function slideCanvas(W) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Math.round(W * PAGE_H / PAGE_W);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return [c, ctx];
}

// SVG (vetorial) é desenhado em 3840 px de largura, nítido até em telas Retina.
// Imagens comuns mantêm a própria resolução (sem ampliar à toa), até 3840 px.
async function makeBackground(file) {
  const img = await loadImg(await readFile(file));
  const ratio = PAGE_W / PAGE_H;
  const vector = file.type === 'image/svg+xml';
  const { cover } = fitToSlide(img.width, img.height, ratio, 1);
  const fit = cover ? Math.min(img.width, img.height * ratio) : Math.max(img.width, img.height * ratio);
  const [c, ctx] = slideCanvas(vector ? 3840 : Math.round(clamp(fit, PAGE_W, 3840)));
  const f = fitToSlide(img.width, img.height, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, f.x, f.y, img.width * f.sc, img.height * f.sc);
  return encodeCanvas(c, vector || file.type === 'image/png');
}

/* ---------- PDF como fundo ---------- */

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/';
let pdfjs = null;
function loadPdfjs() {
  pdfjs ||= import(PDFJS + 'pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    return m;
  });
  pdfjs.catch(() => { pdfjs = null; });
  return pdfjs;
}

const isPdf = (file) => file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name || '');

// Uma página do PDF desenhada direto em 2560 px de largura (o PDF é vetorial, então fica nítido).
async function pdfPageBackground(doc, n) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const [c, ctx] = slideCanvas(2560);
  const f = fitToSlide(vp.width, vp.height, c.width, c.height);
  const pv = page.getViewport({ scale: f.sc });
  const pc = document.createElement('canvas');
  pc.width = Math.ceil(pv.width);
  pc.height = Math.ceil(pv.height);
  await page.render({ canvasContext: pc.getContext('2d'), viewport: pv, background: '#fff' }).promise;
  ctx.drawImage(pc, Math.round(f.x), Math.round(f.y));
  page.cleanup();
  return encodeCanvas(c, true, 1_500_000);
}

// Novo quadro logo depois de `pid`.
function insertPageAfter(pid) {
  const list = pageList();
  const pages = S.meta.pages;
  const next = list[list.indexOf(pid) + 1];
  const ord = (id) => pages[id]?.order || 0;
  const order = next ? (ord(pid) + ord(next)) / 2 : ord(pid) + 1;
  const np = rid();
  S.sync.setMeta({ ['pages/' + np]: { order } });
  return np;
}

// Troca o fundo de um quadro; devolve as entradas para o histórico.
function putBackground(src, pid = S.page) {
  const entries = pageBackgrounds(pid).map((id) => ({ id, before: clone(S.objects.get(id)), after: null }));
  entries.forEach((e) => deleteObject(e.id));
  const id = 'bg' + rid();
  putObject(id, newObj('background', { page: pid, x: 0, y: 0, w: PAGE_W, h: PAGE_H, src, z: -1e13 }));
  entries.push({ id, before: null, after: clone(S.objects.get(id)) });
  return entries;
}

const MAX_PDF_PAGES = 60;

async function setPdfBackground(file) {
  toast('Abrindo o PDF…', 20000);
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    const total = Math.min(doc.numPages, MAX_PDF_PAGES);
    const all = total > 1 && confirm(
      `Este PDF tem ${doc.numPages} páginas.\n\n` +
      `OK: criar um quadro para cada página (a 1ª fica neste quadro).\n` +
      `Cancelar: usar só a 1ª página como fundo deste quadro.` +
      (doc.numPages > MAX_PDF_PAGES ? `\n\n(Serão importadas só as ${MAX_PDF_PAGES} primeiras.)` : ''));
    const count = all ? total : 1;
    const start = S.page;
    const entries = [];
    let pid = start;
    for (let i = 1; i <= count; i++) {
      if (count > 1) toast(`Importando página ${i} de ${count}…`, 20000);
      const src = await pdfPageBackground(doc, i);
      if (!S.sync) return; // saiu do mural no meio
      if (i > 1) pid = insertPageAfter(pid);
      entries.push(...putBackground(src, pid));
    }
    pushHistory(entries);
    renderPagesUI();
    if (count > 1) { toggleFrames(true); toast(`${count} páginas importadas, uma em cada quadro.`); }
    else toast('Fundo do quadro atualizado.');
  } finally {
    doc.destroy();
  }
}

async function setBackground(file) {
  if (!file || !S.sync || !S.page) return;
  try {
    if (isPdf(file)) return await setPdfBackground(file);
    if (!file.type.startsWith('image/')) return toast('Escolha uma imagem ou um PDF.');
    pushHistory(putBackground(await makeBackground(file)));
    renderPagesUI();
  } catch (err) {
    console.error(err);
    toast(isPdf(file) ? 'Não foi possível ler esse PDF.' : 'Não foi possível usar essa imagem como fundo.', 4000);
  }
}

function removeBackground() {
  const entries = pageBackgrounds().map((id) => ({ id, before: clone(S.objects.get(id)), after: null }));
  entries.forEach((e) => deleteObject(e.id));
  pushHistory(entries);
  renderPagesUI();
}

$('#btn-bg').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!S.sync) return;
  const m = $('#bg-menu');
  if (!pageBackgrounds().length) { m.hidden = true; return $('#file-bg').click(); }
  $$('.menu').forEach((x) => { if (x !== m) x.hidden = true; });
  m.hidden = !m.hidden;
});
$('#bg-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bg]');
  if (!b) return;
  $('#bg-menu').hidden = true;
  if (b.dataset.bg === 'change') $('#file-bg').click();
  else removeBackground();
});
$('#file-bg').addEventListener('change', async (e) => {
  await setBackground(e.target.files[0]);
  e.target.value = '';
});

$('#file-image').addEventListener('change', async (e) => {
  for (const f of e.target.files) await addImageFile(f);
  e.target.value = '';
});
boardEl.addEventListener('dragover', (e) => e.preventDefault());
boardEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  const at = worldPt(screenPt(e));
  for (const f of e.dataTransfer.files) await addImageFile(f, at);
});

/* ================= copiar / colar ================= */

document.addEventListener('copy', (e) => {
  if (isTyping(e.target) || !S.roomId || !tr.nodes().length) return;
  e.clipboardData.setData('text/plain', 'jambra:' + JSON.stringify(selectedObjs()));
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (isTyping(e.target) || !S.roomId || !tr.nodes().length) return;
  e.clipboardData.setData('text/plain', 'jambra:' + JSON.stringify(selectedObjs()));
  e.preventDefault();
  deleteSelection();
});
document.addEventListener('paste', (e) => {
  if (isTyping(e.target) || !S.sync) return;
  const img = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (img) { e.preventDefault(); addImageFile(img.getAsFile()); return; }
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  if (text.startsWith('jambra:')) {
    try { duplicate(JSON.parse(text.slice(7))); } catch {}
  } else createText(viewCenter(), text.slice(0, 5000));
});

/* ================= ferramentas e painéis ================= */

function setTool(t) {
  S.tool = t;
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const drag = t === 'select';
  S.nodes.forEach((n) => n.draggable(drag && n.getAttr('otype') !== 'background'));
  if (!drag) select([]);
  boardEl.dataset.tool = t;
  renderToolPanel();
}

function savePrefs() {
  store.set('jambra:prefs', prefs);
  $('.tool[data-tool=pen]').style.setProperty('--c', prefs.pen.color);
  $('.tool[data-tool=highlighter]').style.setProperty('--c', prefs.hl.color);
  $('.tool[data-tool=sticky]').style.setProperty('--c', prefs.stickyColor);
}

function renderToolPanel() {
  const p = $('#tool-panel');
  const swatches = (key, list, cur, sq) =>
    `<div class="row">${list.map((c) => `<button class="sw${sq ? ' sq' : ''}${c === cur ? ' active' : ''}" style="--c:${c}" data-set="${key}" data-val="${c}"></button>`).join('')}</div>`;
  const sizes = (key, list, cur) =>
    `<div class="row">${list.map(([v, d, label]) => `<button class="size${v === cur ? ' active' : ''}" data-set="${key}" data-val="${v}" data-num title="${label}"><i style="--d:${d}px"></i></button>`).join('')}</div>`;
  let html = '';
  switch (S.tool) {
    case 'pen':
      html = swatches('pen.color', COLORS, prefs.pen.color) + sizes('pen.width', [[2, 4, 'Fino'], [4, 7, 'Médio'], [8, 11, 'Grosso'], [16, 16, 'Extra grosso']], prefs.pen.width);
      break;
    case 'highlighter':
      html = swatches('hl.color', HL_COLORS, prefs.hl.color) + sizes('hl.width', [[14, 9, 'Fino'], [24, 13, 'Médio'], [40, 18, 'Grosso']], prefs.hl.width);
      break;
    case 'sticky':
      html = swatches('stickyColor', STICKY, prefs.stickyColor, true);
      break;
    case 'text':
      html = swatches('text.color', COLORS, prefs.text.color) + sizes('text.size', [[20, 7, 'Pequeno'], [32, 11, 'Médio'], [56, 16, 'Grande']], prefs.text.size);
      break;
    case 'shape':
      html = `<div class="row">${SHAPES.map(([k, label]) => `<button class="icon-btn${k === prefs.shape.kind ? ' active' : ''}" data-set="shape.kind" data-val="${k}" title="${label}"><svg><use href="#i-${k}"/></svg></button>`).join('')}</div>`
        + swatches('shape.color', COLORS, prefs.shape.color);
      break;
    case 'eraser':
      html = '<button class="btn" data-action="clear-page"><svg><use href="#i-del"/></svg>Limpar quadro</button>';
      break;
  }
  if (!html) { p.hidden = true; return; }
  p.innerHTML = html;
  p.hidden = false;
  const b = $(`.tool[data-tool=${S.tool}]`).getBoundingClientRect();
  const vertical = getComputedStyle($('#toolbar')).flexDirection === 'column';
  if (vertical) {
    p.style.left = b.right + 12 + 'px';
    p.style.top = b.top + 'px';
    p.style.bottom = '';
  } else {
    p.style.left = clamp(b.left, 8, innerWidth - p.offsetWidth - 8) + 'px';
    p.style.top = '';
    p.style.bottom = innerHeight - b.top + 12 + 'px';
  }
}

$('#tool-panel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-set]');
  if (!b) return;
  const [a, k] = b.dataset.set.split('.');
  const v = 'num' in b.dataset ? Number(b.dataset.val) : b.dataset.val;
  if (k) prefs[a][k] = v;
  else prefs[a] = v;
  savePrefs();
  renderToolPanel();
});

$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  if (b.dataset.tool === S.tool) {
    const p = $('#tool-panel');
    if (p.hidden) renderToolPanel();
    else p.hidden = true;
  } else setTool(b.dataset.tool);
});

function closePopups() {
  $('#tool-panel').hidden = true;
  $$('.menu').forEach((m) => (m.hidden = true));
}

/* ================= quadros (páginas) ================= */

const pageList = () =>
  Object.entries(S.meta.pages || {})
    .sort((a, b) => (a[1].order || 0) - (b[1].order || 0) || a[0].localeCompare(b[0]))
    .map(([id]) => id);

function goPage(pid) {
  if (!pid) return;
  S.page = pid;
  select([]);
  S.nodes.forEach((n, id) => n.visible(S.objects.get(id)?.page === pid));
  fitView();
  renderPagesUI();
  updateBg();
  updateCursors();
  layer.batchDraw();
  sendPresence();
}

function renderPagesUI() {
  renderFrames();
  $('#btn-bg').classList.toggle('active', pageBackgrounds().length > 0);
  const list = pageList();
  const i = list.indexOf(S.page);
  $('#page-num').textContent = `${i + 1} / ${list.length}`;
  $('#page-prev').disabled = i <= 0;
  $('#page-next').disabled = i >= list.length - 1;
}

function stepPage(d) {
  const list = pageList();
  const next = list[list.indexOf(S.page) + d];
  if (next) goPage(next);
}

function addPage() {
  const list = pageList();
  const order = Math.max(0, ...list.map((id) => S.meta.pages[id].order || 0)) + 1;
  const pid = rid();
  S.sync.setMeta({ ['pages/' + pid]: { order } });
  goPage(pid);
}

function deletePage(pid = S.page) {
  const list = pageList();
  if (list.length < 2) return toast('O mural precisa ter pelo menos um quadro.');
  if (!confirm('Excluir este quadro e tudo que está nele?')) return;
  const idx = list.indexOf(pid);
  [...S.objects].filter(([, o]) => o.page === pid).forEach(([id]) => deleteObject(id));
  if (pid === S.page) goPage(list[idx + 1] || list[idx - 1]);
  S.sync.setMeta({ ['pages/' + pid]: null });
  thumbs.delete(pid);
  S.undo = [];
  S.redo = [];
  updateUndo();
}

// Cópia do quadro logo depois dele, com todos os objetos.
function duplicatePage(pid) {
  const np = insertPageAfter(pid);
  for (const o of [...S.objects.values()].filter((o) => o.page === pid)) putObject(rid(), { ...clone(o), page: np });
  goPage(np);
}

// Coloca o quadro pid logo antes de beforeId (ou no fim, se beforeId for nulo).
function movePage(pid, beforeId) {
  const list = pageList().filter((id) => id !== pid);
  const i = beforeId ? list.indexOf(beforeId) : list.length;
  const ord = (id) => S.meta.pages[id]?.order || 0;
  const prev = list[i - 1], next = list[i];
  const order = prev == null ? ord(next) - 1 : next == null ? ord(prev) + 1 : (ord(prev) + ord(next)) / 2;
  S.sync.setMeta({ [`pages/${pid}/order`]: order });
}

/* ---------- faixa de miniaturas ---------- */

const thumbs = new Map();
const stalePages = new Set();
let framesTimer = null;

function markPage(pid) {
  if (!pid) return;
  if (pid === S.page) $('#btn-bg').classList.toggle('active', pageBackgrounds().length > 0);
  stalePages.add(pid);
  if (S.framesOpen) { clearTimeout(framesTimer); framesTimer = setTimeout(renderFrames, 500); }
}

// Desenha um quadro (mesmo que não seja o atual) numa imagem pequena.
function renderThumb(pid) {
  const changed = [];
  S.nodes.forEach((n, id) => {
    const v = S.objects.get(id)?.page === pid;
    if (n.visible() !== v) { changed.push([n, n.visible()]); n.visible(v); }
  });
  const url = renderPageImage(320, 1);
  changed.forEach(([n, v]) => n.visible(v));
  layer.batchDraw();
  return url;
}

function renderFrames() {
  const el = $('#frames');
  document.body.classList.toggle('frames-open', !!S.framesOpen && !!S.roomId);
  if (!S.framesOpen || !S.roomId) return;
  const list = pageList();
  for (const pid of list) if (stalePages.has(pid) || !thumbs.has(pid)) thumbs.set(pid, renderThumb(pid));
  stalePages.clear();
  el.innerHTML = list.map((pid, i) => `
    <div class="frame${pid === S.page ? ' active' : ''}" data-page="${pid}" draggable="true" title="Quadro ${i + 1}">
      <img src="${thumbs.get(pid)}" alt="" draggable="false">
      <span class="num">${i + 1}</span>
      <span class="acts">
        <button data-frame="dup" title="Duplicar quadro"><svg><use href="#i-dup"/></svg></button>
        <button data-frame="del" title="Excluir quadro"><svg><use href="#i-del"/></svg></button>
      </span>
    </div>`).join('') + '<button class="frame-add" data-frame="add" title="Novo quadro"><svg><use href="#i-plus"/></svg></button>';
  el.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function toggleFrames(open = !S.framesOpen) {
  S.framesOpen = open;
  store.set('jambra:frames', open);
  renderFrames();
}

$('#page-label').addEventListener('click', () => toggleFrames());

$('#frames').addEventListener('click', (e) => {
  const b = e.target.closest('[data-frame]');
  const f = e.target.closest('.frame');
  if (b?.dataset.frame === 'add') return addPage();
  if (!f) return;
  const pid = f.dataset.page;
  if (b?.dataset.frame === 'dup') return duplicatePage(pid);
  if (b?.dataset.frame === 'del') return deletePage(pid);
  goPage(pid);
});

let dragPage = null;
$('#frames').addEventListener('dragstart', (e) => {
  const f = e.target.closest('.frame');
  if (!f) return;
  dragPage = f.dataset.page;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragPage);
});
$('#frames').addEventListener('dragover', (e) => {
  if (!dragPage) return;
  e.preventDefault();
  $$('.frame.drop-before, .frame-add.drop-before').forEach((x) => x.classList.remove('drop-before'));
  e.target.closest('.frame, .frame-add')?.classList.add('drop-before');
});
$('#frames').addEventListener('drop', (e) => {
  if (!dragPage) return;
  e.preventDefault();
  const t = e.target.closest('.frame, .frame-add');
  if (t && t.dataset.page !== dragPage) movePage(dragPage, t.dataset.page || null);
});
$('#frames').addEventListener('dragend', () => {
  dragPage = null;
  $$('.drop-before').forEach((x) => x.classList.remove('drop-before'));
});

$('#page-prev').addEventListener('click', () => stepPage(-1));
$('#page-next').addEventListener('click', () => stepPage(1));
$('#page-add').addEventListener('click', addPage);

function applyMeta(m) {
  S.meta = m || {};
  S.meta.pages ||= {};
  setPageSize(S.meta.size);
  const title = $('#title');
  if (document.activeElement !== title) title.value = S.meta.title || '';
  document.title = (S.meta.title || 'Mural sem título') + ' — Jambra';
  const list = pageList();
  if (S.page && list.length && !list.includes(S.page)) goPage(list[0]);
  renderPagesUI();
  updateBg();
  saveRecent();
  markDirty();
}

const sendTitle = throttle((t) => S.sync?.setMeta({ title: t }), 400);
$('#title').addEventListener('input', (e) => sendTitle(e.target.value.slice(0, 80)));
$('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });

/* ================= presença (quem está no mural) ================= */

function sendPresence(pos) {
  if (!S.sync) return;
  if (pos) S.lastPos = pos;
  S.sync.setPresence({ name: S.me.custom || null, joined: S.me.joined, color: S.me.color, page: S.page, ...S.lastPos, t: Date.now() });
}

function makeCursor() {
  const g = new Konva.Group({ listening: false });
  g.add(new Konva.Path({ name: 'arrow', data: 'M0 0 L0 17 L4.6 12.6 L7.6 19.5 L10.4 18.3 L7.4 11.5 L13.5 11.5 Z', stroke: '#fff', strokeWidth: 1.2 }));
  const label = new Konva.Label({ x: 13, y: 18 });
  label.add(new Konva.Tag({ name: 'tag', cornerRadius: 4 }));
  label.add(new Konva.Text({ name: 'label', fontSize: 12, fontFamily: FONT, padding: 4, fill: '#fff' }));
  g.add(label);
  ui.add(g);
  return g;
}

function updateCursor(peer) {
  const { node, data: p } = peer;
  const s = 1 / stage.scaleX();
  node.visible(p.page === S.page && p.x != null);
  node.setAttrs({ x: p.x || 0, y: p.y || 0, scaleX: s, scaleY: s });
  node.findOne('.arrow').fill(p.color);
  node.findOne('.tag').fill(p.color);
  node.findOne('.label').text(nameOf(peer.id, p));
  ui.batchDraw();
}
const updateCursors = () => S.peers.forEach(updateCursor);

function applyPresence(id, p) {
  if (id === S.me.id) return;
  let peer = S.peers.get(id);
  if (!p) {
    if (peer) { peer.node.destroy(); S.peers.delete(id); renderPeople(); updateCursors(); ui.batchDraw(); }
    return;
  }
  const isNew = !peer;
  if (!peer) S.peers.set(id, (peer = { id, node: makeCursor() }));
  const changed = isNew || peer.data.name !== p.name || peer.data.color !== p.color || peer.data.joined !== p.joined;
  peer.data = p;
  if (changed) { renderPeople(); updateCursors(); }
  else updateCursor(peer);
}

// Visitantes sem nome são numerados de 1 até N pela ordem em que entraram no mural.
// Todos calculam a partir da mesma lista de presença, então veem os mesmos números.
function visitorRanks() {
  const list = [{ id: S.me.id, name: S.me.custom, joined: S.me.joined }, ...[...S.peers.values()].map((p) => ({ id: p.id, ...p.data }))]
    .filter((p) => !p.name)
    .sort((a, b) => (a.joined || a.t || 0) - (b.joined || b.t || 0) || String(a.id).localeCompare(String(b.id)));
  return new Map(list.map((p, i) => [p.id, i + 1]));
}
const nameOf = (id, data) => data?.name || `Visitante ${visitorRanks().get(id) || 1}`;
const myName = () => nameOf(S.me.id, { name: S.me.custom });

const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function renderPeople() {
  const list = [
    { me: true, color: S.me.color, name: myName() },
    ...[...S.peers.values()].sort((a, b) => (a.data.joined || 0) - (b.data.joined || 0)).map((p) => ({ color: p.data.color, name: nameOf(p.id, p.data) })),
  ];
  const shown = list.slice(0, 6);
  $('#people').innerHTML =
    shown.map((p) => `<span class="avatar" style="--c:${esc(p.color)}" title="${esc(p.name)}${p.me ? ' (você) — clique para mudar' : ''}" ${p.me ? 'data-me' : ''}>${esc(initials(p.name))}</span>`).join('') +
    (list.length > 6 ? `<span class="avatar more" title="${list.length - 6} pessoas a mais">+${list.length - 6}</span>` : '');
}

$('#people').addEventListener('click', (e) => { if (e.target.closest('[data-me]')) renameMe(); });

function renameMe() {
  const name = prompt('Como você quer aparecer para os outros?\n(Deixe em branco para voltar a ser "Visitante" com número.)', S.me.custom || '');
  if (name == null) return;
  S.me.custom = name.trim().slice(0, 40) || null;
  store.set('jambra:name', S.me.custom);
  renderPeople();
  updateCursors();
  sendPresence();
}

function renameBoard() {
  const t = prompt('Nome do mural', S.meta.title || '');
  if (t != null && S.sync) S.sync.setMeta({ title: t.trim().slice(0, 80) });
}

// Mantém a presença viva e remove quem sumiu sem avisar.
setInterval(() => {
  sendPresence();
  const now = Date.now();
  for (const [id, p] of S.peers) if (now - (p.data.t || 0) > 90_000) applyPresence(id, null);
}, 30_000);

function setStatus(s, err) {
  const el = $('#status');
  el.dataset.s = s;
  el.title = { online: 'Ao vivo — as alterações aparecem para todos', offline: 'Sem conexão — tentando reconectar', local: 'Modo local — sem colaboração (configure o Firebase)', error: 'Erro de sincronização', connecting: 'Conectando…' }[s] || s;
  if (s === 'error') {
    console.error(err);
    const denied = /permission/i.test(err?.message || err?.code || '');
    toast(denied ? 'Sem permissão no Firebase — confira as regras e o login anônimo (README).' : 'Erro de sincronização: ' + (err?.message || err), 6000);
  }
}

/* ================= abrir / fechar mural ================= */

async function openBoard(roomId, opts = {}) {
  if (S.roomId === roomId) return;
  closeBoard();
  const token = Symbol();
  S.token = token;
  S.roomId = roomId;
  S.loading = true;
  if (location.hash !== '#b=' + roomId) location.hash = 'b=' + roomId;
  $('#home').hidden = true;
  setStatus('connecting');
  setTool(S.tool);
  $('#tool-panel').hidden = true;

  const live = (fn) => (...a) => S.token === token && fn(...a);
  let sync;
  try {
    sync = await createSync(roomId, {
      object: live(applyObject),
      meta: live(applyMeta),
      presence: live(applyPresence),
      status: live(setStatus),
    });
  } catch (e) {
    console.error(e);
    if (S.token === token) {
      toast('Não foi possível conectar: ' + e.message, 6000);
      goHome();
    }
    return;
  }
  if (S.token !== token) return sync.close();
  S.sync = sync;
  S.me.id = sync.id;
  S.me.joined = Date.now();

  await Promise.race([sync.ready, wait(8000)]);
  if (S.token !== token) return;
  if (opts.snapshot && (await sync.isEmpty())) await sync.load(opts.snapshot);
  if (opts.isNew) sync.setMeta({ title: 'Mural sem título', created: Date.now(), size: SLIDE_SIZE });
  if (!pageList().length) sync.setMeta({ ['pages/' + rid()]: { order: 0 } });
  goPage(pageList()[0]);
  renderPeople();
  updateUndo();
  S.dirty = !!opts.isNew;
  updateDriveBtn();
  setTimeout(() => {
    if (S.token !== token) return;
    S.loading = false;
  }, 2500);
}

function closeBoard() {
  if (S.editing) document.activeElement?.blur();
  cancelGesture();
  S.token = null;
  S.sync?.close();
  S.sync = null;
  S.roomId = null;
  select([]);
  S.nodes.forEach((n) => n.destroy());
  S.nodes.clear();
  S.objects.clear();
  S.peers.forEach((p) => p.node.destroy());
  S.peers.clear();
  S.meta = { pages: {} };
  S.page = null;
  S.undo = [];
  S.redo = [];
  S.busy.clear();
  S.dirty = false;
  S.driveError = false;
  thumbs.clear();
  stalePages.clear();
  document.body.classList.remove('frames-open');
  S.lastPos = null;
  S.lastSaved = null;
  layer.batchDraw();
  ui.batchDraw();
}

function goHome() {
  history.pushState(null, '', location.pathname + location.search);
  route();
}

function showHome() {
  closeBoard();
  document.title = 'Jambra';
  $('#home').hidden = false;
  renderRecents();
}

function route() {
  const m = location.hash.match(/b=([a-z0-9]+)/i);
  if (m) openBoard(m[1]);
  else showHome();
}
addEventListener('hashchange', route);

function saveRecent() {
  if (!S.roomId) return;
  const list = store.get('jambra:recent', []).filter((r) => r.id !== S.roomId);
  list.unshift({ id: S.roomId, title: S.meta.title || 'Mural sem título', t: Date.now() });
  store.set('jambra:recent', list.slice(0, 15));
}

const fmtDate = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function renderRecents() {
  const list = store.get('jambra:recent', []);
  $('#recents').innerHTML = list.length
    ? list.map((r) => `<li><button data-room="${esc(r.id)}"><span>${esc(r.title)}</span><time>${fmtDate(r.t)}</time></button></li>`).join('')
    : '<li class="muted">Os murais que você abrir aparecem aqui.</li>';
  const notes = [];
  if (!hasFirebase()) notes.push('<p><b>Modo local:</b> a colaboração ao vivo está desligada e os murais ficam só neste navegador. Preencha <code>firebase</code> em <code>js/config.js</code> (veja o README).</p>');
  if (!Drive.enabled()) notes.push('<p><b>Google Drive não configurado:</b> preencha <code>googleClientId</code> em <code>js/config.js</code>.</p>');
  $('#setup-note').innerHTML = notes.join('');
  $('#setup-note').hidden = !notes.length;
}

$('#recents').addEventListener('click', (e) => {
  const b = e.target.closest('[data-room]');
  if (b) openBoard(b.dataset.room);
});

/* ================= arquivo, imagem e Drive ================= */

function snapshot() {
  return {
    app: 'jambra', v: 1, roomId: S.roomId, savedAt: new Date().toISOString(),
    meta: clone(S.meta),
    objects: Object.fromEntries([...S.objects].map(([id, o]) => [id, clone(o)])),
  };
}

// Imagem do slide atual, com fundo branco.
function renderPageImage(maxPx, scale) {
  const s = stage.scaleX();
  const box = { x: stage.x(), y: stage.y(), width: PAGE_W * s, height: PAGE_H * s };
  const pixelRatio = Math.min(scale / s, maxPx / Math.max(box.width, box.height));
  const bg = new Konva.Rect({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, fill: '#fff', listening: false });
  layer.add(bg);
  bg.moveToBottom();
  const url = layer.toDataURL({ ...box, pixelRatio });
  bg.destroy();
  layer.batchDraw();
  return url;
}

function exportPNG() {
  const url = renderPageImage(Math.max(1920, PAGE_W * 2), Math.max(2, 1920 / PAGE_W));
  const n = pageList().indexOf(S.page) + 1;
  download(url, `${fileName()} - quadro ${n}.png`);
}

function downloadJSON() {
  const blob = new Blob([JSON.stringify(snapshot())], { type: 'application/json' });
  download(URL.createObjectURL(blob), fileName() + '.jambra.json');
}

$('#file-json').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const snap = JSON.parse(await f.text());
    if (snap.app !== 'jambra' || !snap.objects) throw new Error('formato');
    await openBoard(rid(12), { snapshot: snap });
    toast('Arquivo importado como um novo mural.');
  } catch {
    toast('Esse arquivo não parece ser um mural do Jambra.');
  }
});

function markDirty() {
  if (S.loading) return;
  S.dirtyV++;
  if (!S.dirty) { S.dirty = true; updateDriveBtn(); }
}

const driveKey = (roomId) => 'jambra:file:' + roomId;
const NO_DRIVE = 'Google Drive não configurado — preencha googleClientId em js/config.js (veja o README).';

function driveState() {
  if (!Drive.enabled() || !Drive.connected()) return 'off';
  if (S.saving) return 'saving';
  if (S.driveError) return 'error';
  if (S.needAuth || !Drive.hasToken()) return 'reauth';
  if (!S.roomId || !store.get(driveKey(S.roomId))) return 'new';
  return S.dirty ? 'dirty' : 'saved';
}

function updateDriveBtn() {
  const b = $('#btn-drive');
  const st = driveState();
  const [label, title] = {
    off: ['Google Drive', 'Conectar ao Google Drive'],
    new: ['Salvar no Drive', 'Este mural ainda não está no seu Drive'],
    saving: ['Salvando…', 'Salvando na pasta "Jambra"'],
    saved: ['Salvo no Drive', 'Tudo salvo na pasta "Jambra" do seu Drive'],
    dirty: ['Salvando em breve', 'Há alterações que serão salvas automaticamente em alguns segundos'],
    error: ['Erro ao salvar', 'Não foi possível salvar no Drive'],
    reauth: ['Reconectar Drive', 'O login do Google expirou'],
  }[st];
  b.dataset.state = st;
  b.querySelector('span').textContent = label;
  b.title = title;
  if (!$('#drive-menu').hidden) renderDriveMenu();
}

function renderDriveMenu() {
  const m = $('#drive-menu');
  const a = Drive.account();
  const item = (act, label, extra = '') => `<button data-drive="${act}" ${extra}>${label}</button>`;
  if (!Drive.enabled()) {
    m.innerHTML = `<div class="menu-note">${esc(NO_DRIVE)}</div>`;
    return;
  }
  if (!a) {
    m.innerHTML = `
      <div class="menu-note">Conecte seu Google Drive para salvar os murais numa pasta <b>Jambra</b>. O app só mexe nos arquivos que ele mesmo cria.</div>
      <button class="btn primary menu-cta" data-drive="connect"><svg><use href="#i-cloud"/></svg>Conectar ao Google Drive</button>`;
    return;
  }
  const st = driveState();
  const status = {
    new: 'Este mural ainda não está no seu Drive.',
    saving: 'Salvando…',
    saved: `Salvo${S.lastSaved ? ' às ' + new Date(S.lastSaved).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}. Salva sozinho a cada alteração.`,
    dirty: 'Alterações serão salvas em alguns segundos.',
    error: 'Não foi possível salvar. Tente de novo.',
    reauth: 'O login expirou. Reconecte para continuar salvando.',
  }[st];
  m.innerHTML = `
    <div class="account">
      ${a.photo ? `<img src="${esc(a.photo)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar" style="--c:#1a73e8">${esc(initials(a.name))}</span>`}
      <div><b>${esc(a.name)}</b><small>${esc(a.email)}</small></div>
    </div>
    ${S.roomId ? `<div class="menu-note">${esc(status)}</div>` : ''}
    ${st === 'reauth' ? item('reauth', 'Reconectar') : ''}
    ${S.roomId && st !== 'reauth' ? item('save', st === 'new' ? 'Salvar este mural no Drive' : 'Salvar agora') : ''}
    ${item('open', 'Abrir mural da pasta Jambra…')}
    <a href="${esc(Drive.folderUrl() || 'https://drive.google.com')}" target="_blank" rel="noopener">Abrir pasta Jambra no Drive ↗</a>
    <hr>
    ${item('disconnect', 'Desconectar do Drive', 'class="danger"')}`;
}

async function connectDrive() {
  if (!Drive.enabled()) return toast(NO_DRIVE, 5000);
  try {
    const a = await Drive.connect();
    S.needAuth = false;
    toast(`Conectado como ${a.email}. Seus murais ficam na pasta "Jambra".`, 4000);
    return true;
  } catch (e) {
    toast('Não foi possível conectar: ' + e.message, 5000);
    return false;
  } finally {
    updateDriveBtn();
  }
}

function disconnectDrive() {
  Drive.disconnect();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith('jambra:file:')) localStorage.removeItem(k);
  }
  S.needAuth = false;
  S.driveError = false;
  S.lastSaved = null;
  updateDriveBtn();
  toast('Google Drive desconectado. Os arquivos continuam na sua pasta "Jambra".', 4000);
}

async function saveToDrive(interactive = true) {
  const roomId = S.roomId;
  if (!roomId) return;
  if (!Drive.enabled()) return toast(NO_DRIVE, 5000);
  if (!Drive.connected() && !(interactive && (await connectDrive()))) return;
  if (S.saving) return;
  S.saving = true;
  S.driveError = false;
  updateDriveBtn();
  const v = S.dirtyV;
  const first = !store.get(driveKey(roomId));
  try {
    const thumb = visibleNodes().length ? renderPageImage(480, 1) : null;
    const id = await Drive.saveBoard({
      fileId: store.get(driveKey(roomId)),
      name: fileName(),
      content: JSON.stringify(snapshot()),
      roomId,
      thumbnail: thumb && thumb.split(',')[1].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      interactive,
    });
    store.set(driveKey(roomId), id);
    S.needAuth = false;
    if (S.roomId === roomId) {
      S.lastSaved = Date.now();
      if (S.dirtyV === v) S.dirty = false;
    }
    if (interactive) toast(first ? 'Salvo na pasta "Jambra" do seu Drive. Daqui pra frente salva sozinho.' : 'Salvo no Google Drive.');
  } catch (e) {
    if (e.code === 'auth') S.needAuth = true;
    else {
      console.error(e);
      S.driveError = true;
      if (interactive) toast('Erro ao salvar no Drive: ' + e.message, 5000);
    }
  } finally {
    S.saving = false;
    updateDriveBtn();
  }
}

// Salvamento automático para murais que já foram salvos no Drive neste navegador.
function autoSave() {
  if (S.roomId && S.dirty && !S.saving && Drive.connected() && Drive.hasToken() && store.get(driveKey(S.roomId))) saveToDrive(false);
}
setInterval(autoSave, 15_000);
setInterval(updateDriveBtn, 60_000); // percebe quando o login expira
document.addEventListener('visibilitychange', () => { if (document.hidden) autoSave(); });

$('#btn-drive').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#drive-menu');
  $('#menu').hidden = true;
  m.hidden = !m.hidden;
  if (!m.hidden) renderDriveMenu();
});

$('#drive-menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-drive], a');
  if (!b) return;
  $('#drive-menu').hidden = true;
  const act = b.dataset.drive;
  if (act === 'connect') await connectDrive();
  else if (act === 'reauth') { if (await connectDrive()) saveToDrive(false); }
  else if (act === 'save') saveToDrive(true);
  else if (act === 'open') openFromDrive();
  else if (act === 'disconnect') disconnectDrive();
});

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
}
const closeModal = () => { $('#modal').hidden = true; };
$('#modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) closeModal();
});

async function openFromDrive() {
  if (!Drive.enabled()) return toast(NO_DRIVE, 5000);
  if (!Drive.connected() && !(await connectDrive())) return;
  openModal('Pasta Jambra no Google Drive', '<div class="loading">Carregando seus murais…</div>');
  try {
    const files = await Drive.listBoards();
    $('#modal-body').innerHTML = files.length
      ? `<div class="file-list">${files.map((f) => `
          <div class="file-row">
            <button class="file-open" data-file="${esc(f.id)}" data-room="${esc(f.appProperties?.room || '')}"><span class="name">${esc(f.name.replace(/\.jambra\.json$/, ''))}</span><time>Salvo em ${fmtDate(f.modifiedTime)}</time></button>
            <button class="icon-btn" data-trash="${esc(f.id)}" title="Mandar para a lixeira do Drive"><svg><use href="#i-del"/></svg></button>
          </div>`).join('')}</div>`
      : '<p>A pasta "Jambra" ainda está vazia. Abra um mural e use “Salvar no Drive”.</p>';
  } catch (e) {
    $('#modal-body').innerHTML = `<p>Não foi possível acessar o Drive: ${esc(e.message)}</p>`;
  }
}

$('#modal-body').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-trash]');
  if (t) {
    if (!confirm('Mandar este mural para a lixeira do Drive? (O mural ao vivo continua existindo pelo link.)')) return;
    try {
      await Drive.trashBoard(t.dataset.trash);
      t.closest('.file-row').remove();
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith('jambra:file:') && store.get(k) === t.dataset.trash) localStorage.removeItem(k);
      }
      updateDriveBtn();
    } catch (err) {
      toast('Não foi possível apagar: ' + err.message);
    }
    return;
  }
  const b = e.target.closest('[data-file]');
  if (!b) return;
  $('#modal-body').innerHTML = '<div class="loading">Abrindo o mural…</div>';
  try {
    const snap = await Drive.loadBoard(b.dataset.file);
    const roomId = snap.roomId || b.dataset.room || rid(12);
    store.set(driveKey(roomId), b.dataset.file);
    closeModal();
    if (S.roomId === roomId) return;
    await openBoard(roomId, { snapshot: snap });
  } catch (err) {
    $('#modal-body').innerHTML = `<p>Não foi possível abrir: ${esc(err.message)}</p>`;
  }
});

async function share() {
  if (!S.roomId) return;
  const url = location.origin + location.pathname + '#b=' + S.roomId;
  try {
    await navigator.clipboard.writeText(url);
    toast(hasFirebase()
      ? 'Link copiado! Quem abrir o link pode editar junto com você.'
      : 'Link copiado — mas no modo local ninguém mais consegue editar. Configure o Firebase para colaborar.', 5000);
  } catch {
    prompt('Copie o link do mural:', url);
  }
}

/* ================= menus, ações e atalhos ================= */

const ACTIONS = {
  new: () => openBoard(rid(12), { isNew: true }),
  home: goHome,
  'open-drive': openFromDrive,
  import: () => $('#file-json').click(),
  download: downloadJSON,
  'export-png': exportPNG,
  'rename-me': renameMe,
  'rename-board': renameBoard,
  'delete-page': deletePage,
  'clear-page': clearPage,
  image: () => $('#file-image').click(),
  undo,
  redo,
  'zoom-in': () => zoomCenter(1.25),
  'zoom-out': () => zoomCenter(0.8),
  'zoom-reset': fitView,
  'zoom-fit': fitView,
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  $('#menu').hidden = true;
  ACTIONS[a.dataset.action]?.(a);
});

$('#btn-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#menu');
  $('#drive-menu').hidden = true;
  m.hidden = !m.hidden;
});
document.addEventListener('pointerdown', (e) => {
  const wrap = e.target.closest('.menu-wrap');
  $$('.menu').forEach((m) => { if (!wrap?.contains(m)) m.hidden = true; });
});

$('#btn-share').addEventListener('click', share);

addEventListener('keydown', (e) => {
  if (isTyping(e.target) || !S.sync || !$('#modal').hidden) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (k === ' ') { if (!spaceDown) { spaceDown = true; boardEl.classList.add('panning'); } e.preventDefault(); return; }
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod && k === 'a') { e.preventDefault(); setTool('select'); select(selectableNodes()); return; }
  if (mod && k === 's') { e.preventDefault(); saveToDrive(true); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomCenter(1.25); return; }
  if (mod && k === '-') { e.preventDefault(); zoomCenter(0.8); return; }
  if (mod && k === '0') { e.preventDefault(); fitView(); return; }
  if (mod || e.altKey) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); return; }
  if (k === 'escape') { select([]); closePopups(); return; }
  if (k === 'pageup') { e.preventDefault(); stepPage(-1); return; }
  if (k === 'pagedown') { e.preventDefault(); stepPage(1); return; }
  if (k === 'enter' && tr.nodes().length === 1) {
    const id = selectedIds()[0];
    const o = S.objects.get(id);
    if (o && (o.type === 'sticky' || o.type === 'text')) { e.preventDefault(); editText(id); }
    return;
  }
  if (k === 'i') { $('#file-image').click(); return; }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; boardEl.classList.remove('panning'); }
});
addEventListener('blur', () => { spaceDown = false; boardEl.classList.remove('panning'); });

/* ================= início ================= */

savePrefs();
setTool('pen');
updateUndo();
renderPeople();
Drive.preload().catch(() => {});
route();

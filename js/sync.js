// Camada de sincronização do mural.
// - FirebaseSync: colaboração ao vivo via Firebase Realtime Database.
// - LocalSync: sem servidor; dados ficam no navegador e abas abertas sincronizam entre si.
// As duas expõem a mesma interface e chamam os handlers também para as próprias escritas.

import { CONFIG } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export const hasFirebase = () => !!(CONFIG.firebase?.apiKey && CONFIG.firebase?.databaseURL);

export function rid(n = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (const x of crypto.getRandomValues(new Uint8Array(n))) s += abc[x % abc.length];
  return s;
}

// Uma sessão = uma aba aberta (a mesma pessoa em duas abas aparece duas vezes).
const SESSION = rid(12);

const clean = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export async function createSync(roomId, handlers) {
  const s = hasFirebase() ? new FirebaseSync(roomId, handlers) : new LocalSync(roomId, handlers);
  await s.connect();
  return s;
}

/* ---------------- Firebase ---------------- */

let fbPromise = null;
function loadFirebase() {
  fbPromise ||= (async () => {
    const [appMod, db, authMod] = await Promise.all([
      import(FB + 'firebase-app.js'),
      import(FB + 'firebase-database.js'),
      import(FB + 'firebase-auth.js'),
    ]);
    const app = appMod.initializeApp(CONFIG.firebase);
    const auth = authMod.getAuth(app);
    await auth.authStateReady();
    if (!auth.currentUser) await authMod.signInAnonymously(auth);
    return { db, database: db.getDatabase(app) };
  })();
  fbPromise.catch(() => { fbPromise = null; });
  return fbPromise;
}

class FirebaseSync {
  constructor(roomId, h) {
    this.roomId = roomId;
    this.h = h;
    this.id = SESSION;
    this.unsubs = [];
    this.err = (e) => this.h.status('error', e);
  }

  async connect() {
    const { db, database } = await loadFirebase();
    this.db = db;
    const root = (this.root = db.ref(database, 'rooms/' + this.roomId));
    const objs = db.child(root, 'objects');
    const pres = db.child(root, 'presence');
    this.presRef = db.child(pres, this.id);

    let ready;
    this.ready = new Promise((r) => (ready = r));
    const fail = (e) => { ready(); this.err(e); };
    const on = (fn, ref, cb) => this.unsubs.push(fn(ref, cb, fail));

    on(db.onValue, db.child(root, 'meta'), (s) => { this.h.meta(s.val() || {}); ready(); });
    on(db.onChildAdded, objs, (s) => this.h.object(s.key, s.val()));
    on(db.onChildChanged, objs, (s) => this.h.object(s.key, s.val()));
    on(db.onChildRemoved, objs, (s) => this.h.object(s.key, null));
    on(db.onChildAdded, pres, (s) => this.h.presence(s.key, s.val()));
    on(db.onChildChanged, pres, (s) => this.h.presence(s.key, s.val()));
    on(db.onChildRemoved, pres, (s) => this.h.presence(s.key, null));
    on(db.onValue, db.ref(database, '.info/connected'), (s) => {
      const online = !!s.val();
      this.h.status(online ? 'online' : 'offline');
      if (online) {
        db.onDisconnect(this.presRef).remove();
        if (this.lastPresence) db.set(this.presRef, this.lastPresence).catch(() => {});
      }
    });
  }

  path(p) { return this.db.child(this.root, p); }
  setObject(id, o) { this.db.set(this.path('objects/' + id), clean(o)).catch(this.err); }
  updateObject(id, p) { this.db.update(this.path('objects/' + id), clean(p)).catch(this.err); }
  removeObject(id) { this.db.remove(this.path('objects/' + id)).catch(this.err); }
  // p aceita caminhos: { title: 'x', 'pages/abc/bg': 'grid', 'pages/def': null }
  setMeta(p) { this.db.update(this.path('meta'), clean(p)).catch(this.err); }
  setPresence(p) {
    this.lastPresence = clean(p);
    this.db.set(this.presRef, this.lastPresence).catch(() => {});
  }
  async isEmpty() { return !(await this.db.get(this.path('objects'))).exists(); }
  async load(snap) {
    await this.db.update(this.root, { objects: clean(snap.objects || {}), meta: clean(snap.meta || {}) });
  }
  close() {
    this.unsubs.forEach((u) => u());
    this.db.onDisconnect(this.presRef).cancel().catch(() => {});
    this.db.remove(this.presRef).catch(() => {});
  }
}

/* ---------------- Local ---------------- */

function setPath(obj, path, val) {
  const parts = path.split('/');
  const last = parts.pop();
  let cur = obj;
  for (const k of parts) cur = cur[k] && typeof cur[k] === 'object' ? cur[k] : (cur[k] = {});
  if (val === null) delete cur[last];
  else cur[last] = val;
}

class LocalSync {
  constructor(roomId, h) {
    this.roomId = roomId;
    this.h = h;
    this.id = SESSION;
    this.key = 'jambra:room:' + roomId;
    this.ready = Promise.resolve();
  }

  async connect() {
    try { this.state = JSON.parse(localStorage.getItem(this.key)); } catch { this.state = null; }
    this.state ||= { meta: {}, objects: {} };
    if ('BroadcastChannel' in window) {
      this.bc = new BroadcastChannel('jambra:' + this.roomId);
      this.bc.onmessage = (e) => this.receive(e.data);
    }
    this.onHide = () => { this.flush(); this.post({ t: 'pres', id: this.id, p: null }); };
    addEventListener('pagehide', this.onHide);
    this.h.status('local');
    this.h.meta(clean(this.state.meta));
    for (const [id, o] of Object.entries(this.state.objects)) this.h.object(id, clean(o));
    this.post({ t: 'hello' });
  }

  receive(m) {
    if (m.t === 'obj') {
      if (m.o) this.state.objects[m.id] = m.o;
      else delete this.state.objects[m.id];
      this.h.object(m.id, clean(m.o));
    } else if (m.t === 'meta') {
      for (const [k, v] of Object.entries(m.p)) setPath(this.state.meta, k, v);
      this.h.meta(clean(this.state.meta));
    } else if (m.t === 'reset') {
      this.replace(m.state);
    } else if (m.t === 'pres') {
      this.h.presence(m.id, m.p);
    } else if (m.t === 'hello' && this.lastPresence) {
      this.post({ t: 'pres', id: this.id, p: this.lastPresence });
    }
  }

  replace(state) {
    const old = this.state.objects;
    this.state = state;
    for (const id of Object.keys(old)) if (!state.objects[id]) this.h.object(id, null);
    this.h.meta(clean(state.meta));
    for (const [id, o] of Object.entries(state.objects)) this.h.object(id, clean(o));
  }

  post(m) { this.bc?.postMessage(m); }
  persist() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 300); }
  flush() {
    clearTimeout(this.timer);
    try { localStorage.setItem(this.key, JSON.stringify(this.state)); }
    catch (e) { this.h.status('error', new Error('Armazenamento do navegador cheio')); }
  }

  setObject(id, o) {
    o = clean(o);
    this.state.objects[id] = o;
    this.h.object(id, clean(o));
    this.post({ t: 'obj', id, o });
    this.persist();
  }
  updateObject(id, p) {
    const cur = this.state.objects[id];
    if (!cur) return;
    // aceita caminhos como no Firebase: { 'likes/abc': true }
    const o = clean(cur);
    for (const [k, v] of Object.entries(clean(p))) setPath(o, k, v);
    this.setObject(id, o);
  }
  removeObject(id) {
    delete this.state.objects[id];
    this.h.object(id, null);
    this.post({ t: 'obj', id, o: null });
    this.persist();
  }
  setMeta(p) {
    p = clean(p);
    for (const [k, v] of Object.entries(p)) setPath(this.state.meta, k, v);
    this.h.meta(clean(this.state.meta));
    this.post({ t: 'meta', p });
    this.persist();
  }
  setPresence(p) {
    this.lastPresence = clean(p);
    this.post({ t: 'pres', id: this.id, p: this.lastPresence });
  }
  async isEmpty() { return !Object.keys(this.state.objects).length; }
  async load(snap) {
    const state = { meta: clean(snap.meta || {}), objects: clean(snap.objects || {}) };
    this.replace(state);
    this.flush();
    this.post({ t: 'reset', state });
  }
  close() {
    this.onHide();
    removeEventListener('pagehide', this.onHide);
    this.bc?.close();
  }
}

// Integração com o Google Drive (login pelo navegador, sem servidor).
// Usa o escopo drive.file: o app só enxerga os arquivos que ele mesmo criou.
// Tudo fica na pasta "Jambra" do Drive de quem conectou.

import { CONFIG } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'Jambra';
const K_ACCOUNT = 'jambra:drive';
const K_TOKEN = 'jambra:drive-token';

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const save = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// O token dura 1 hora; guardá-lo evita pedir login de novo a cada recarregada.
let { token = null, expires = 0 } = load(K_TOKEN) || {};
let client = null;
let gis = null;
let onToken = () => {};
let onError = () => {};

export const enabled = () => !!CONFIG.googleClientId;
export const account = () => load(K_ACCOUNT); // { name, email, photo, folderId } ou null
export const connected = () => !!account();
export const hasToken = () => !!token && Date.now() < expires - 60_000;
export const folderUrl = () => { const a = account(); return a?.folderId ? `https://drive.google.com/drive/folders/${a.folderId}` : null; };

// Carregar o script do Google cedo evita que o pop-up de login seja bloqueado.
export function preload() {
  if (!enabled()) return Promise.resolve();
  gis ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { gis = null; reject(new Error('Não foi possível carregar o login do Google')); };
    document.head.appendChild(s);
  });
  return gis;
}

function authError() {
  const e = new Error('Conecte o Google Drive para continuar');
  e.code = 'auth';
  return e;
}

function setToken(t, secs) {
  token = t;
  expires = t ? Date.now() + secs * 1000 : 0;
  save(K_TOKEN, t ? { token, expires } : null);
}

async function getToken(interactive) {
  if (hasToken()) return token;
  if (!interactive) throw authError();
  await preload();
  client ||= google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.googleClientId,
    scope: SCOPE,
    callback: (r) => onToken(r),
    error_callback: (e) => onError(e),
  });
  return new Promise((resolve, reject) => {
    onToken = (r) => {
      if (r.error) return reject(new Error(r.error_description || r.error));
      setToken(r.access_token, r.expires_in);
      resolve(token);
    };
    onError = (e) =>
      reject(new Error(e?.type === 'popup_closed' ? 'Login cancelado' : 'Não foi possível abrir o login (pop-up bloqueado?)'));
    client.requestAccessToken({ prompt: '', hint: account()?.email });
  });
}

async function gfetch(url, opts = {}, interactive = true, retry = true) {
  const t = await getToken(interactive);
  const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + t } });
  if (res.status === 401 && retry) {
    setToken(null);
    return gfetch(url, opts, interactive, false);
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).error.message; } catch {}
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res;
}

const json = async (...a) => (await gfetch(...a)).json();

// Procura a pasta "Jambra" criada pelo app; cria se não existir (ou se foi para a lixeira).
async function findOrCreateFolder(interactive) {
  const q = new URLSearchParams({
    q: `mimeType='application/vnd.google-apps.folder' and name='${FOLDER}' and trashed=false`,
    fields: 'files(id)',
  });
  const found = await json(`${API}/files?${q}`, {}, interactive);
  if (found.files?.length) return found.files[0].id;
  const created = await json(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  }, interactive);
  return created.id;
}

async function folderId(interactive) {
  const a = account();
  if (!a) throw authError();
  if (a.folderId) return a.folderId;
  a.folderId = await findOrCreateFolder(interactive);
  save(K_ACCOUNT, a);
  return a.folderId;
}

// Login + pasta "Jambra". Chamar a partir de um clique (abre o pop-up do Google).
export async function connect() {
  await getToken(true);
  const { user } = await json(`${API}/about?fields=user(displayName,emailAddress,photoLink)`);
  const a = { name: user.displayName, email: user.emailAddress, photo: user.photoLink || null, folderId: null };
  save(K_ACCOUNT, a);
  a.folderId = await findOrCreateFolder(true);
  save(K_ACCOUNT, a);
  return a;
}

export function disconnect() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  setToken(null);
  save(K_ACCOUNT, null);
}

function multipart(meta, content) {
  const b = 'jambra' + Math.random().toString(36).slice(2);
  return {
    headers: { 'Content-Type': `multipart/related; boundary=${b}` },
    body:
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`,
  };
}

// Cria ou atualiza o arquivo do mural dentro da pasta "Jambra". Retorna o id do arquivo.
export async function saveBoard({ fileId, name, content, roomId, thumbnail, interactive = true }) {
  const meta = {
    name: name + '.jambra.json',
    mimeType: 'application/json',
    appProperties: { jambra: '1', room: roomId },
  };
  if (thumbnail) meta.contentHints = { thumbnail: { image: thumbnail, mimeType: 'image/png' } };
  if (fileId) {
    try {
      const r = await json(`${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,trashed`,
        { method: 'PATCH', ...multipart(meta, content) }, interactive);
      if (!r.trashed) return r.id;
    } catch (e) {
      if (e.status !== 404 && e.status !== 403) throw e; // arquivo apagado: cria outro
    }
  }
  const create = async () => {
    meta.parents = [await folderId(interactive)];
    return (await json(`${UPLOAD}/files?uploadType=multipart&fields=id`,
      { method: 'POST', ...multipart(meta, content) }, interactive)).id;
  };
  try {
    return await create();
  } catch (e) {
    if (e.status !== 404) throw e;
    // a pasta sumiu: encontra/cria de novo e tenta outra vez
    const a = account();
    a.folderId = null;
    save(K_ACCOUNT, a);
    return create();
  }
}

// Murais que estão na pasta "Jambra".
export async function listBoards() {
  const q = new URLSearchParams({
    q: `'${await folderId(true)}' in parents and appProperties has { key='jambra' and value='1' } and trashed=false`,
    orderBy: 'modifiedTime desc',
    pageSize: '100',
    fields: 'files(id,name,modifiedTime,appProperties)',
  });
  return (await json(`${API}/files?${q}`)).files || [];
}

export async function loadBoard(fileId) {
  return json(`${API}/files/${fileId}?alt=media`);
}

// Manda para a lixeira do Drive (dá para recuperar por lá).
export async function trashBoard(fileId) {
  await gfetch(`${API}/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

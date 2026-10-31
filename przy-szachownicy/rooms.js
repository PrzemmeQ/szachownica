// Dostawca partii: kluby (prywatne pokoje) i poczekalnia ogólna — bez konta Lichess.
// Jedno połączenie WebSocket z serwerem pokoju; serwer liczy zegar i sprawdza ruchy.
import { t } from './i18n.js';
import { CONFIG } from './config.js';

// Poczekalnia ogólna to stały pokój o tym identyfikatorze. Urządzenie pamięta konto i listę klubów („Moje kluby”).
export const PUBLIC_CODE = 'publiczny';
const LS_ACCOUNT = 'ps_account';
const LS_CLUBS = 'ps_clubs';
const LS_DEVICE = 'ps_device';
const MAX_CLUBS = 20;

function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function lsSet(key, v) { try { if (v) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key); } catch {} }
try { localStorage.removeItem('ps_room'); localStorage.removeItem('ps_public'); } catch {} // dane sprzed wspólnego rankingu

function apiBase() { return String(CONFIG.ROOMS_API || '').replace(/\/+$/, ''); }
export function roomsEnabled() { return !!apiBase(); }
// Losowy identyfikator urządzenia — tylko do blokady za błędne kody klubów (gdy nie ma konta).
export function deviceId() {
  let d = null;
  try { d = localStorage.getItem(LS_DEVICE); } catch {}
  if (!d) {
    d = 'd' + [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(LS_DEVICE, d); } catch {}
  }
  return d;
}

// --- konto (poczekalnia ogólna) ---
export function savedAccount() { const s = lsGet(LS_ACCOUNT); return s && s.token && s.api === apiBase() ? s : null; }
export function forgetAccount() { lsSet(LS_ACCOUNT, null); }
function rememberAccount(d, extra = {}) {
  const s = { api: apiBase(), room: PUBLIC_CODE, name: d.name, memberId: d.memberId, nick: d.nick, token: d.token, secured: true, rooms: d.rooms || [], ...extra };
  lsSet(LS_ACCOUNT, s);
  return s;
}
export function updateAccount(patch) {
  const s = savedAccount();
  if (s) lsSet(LS_ACCOUNT, { ...s, ...patch });
}
function accountToken() { return savedAccount()?.token || undefined; }

// --- kluby na tym urządzeniu ---
export function savedClubs() { return (lsGet(LS_CLUBS) || []).filter((c) => c && c.token && c.api === apiBase()); }
export function savedClub(room) { return savedClubs().find((c) => c.room === room) || null; }
export function forgetClub(room) { lsSet(LS_CLUBS, savedClubs().filter((c) => c.room !== room)); }
function rememberClub(room, d) {
  const c = { api: apiBase(), room, code: d.code, name: d.name, memberId: d.memberId, nick: d.nick, token: d.token, at: Date.now() };
  const list = [c, ...savedClubs().filter((x) => x.room !== room)].slice(0, MAX_CLUBS);
  lsSet(LS_CLUBS, list);
  return c;
}
export function touchClub(room, patch) {
  lsSet(LS_CLUBS, savedClubs().map((c) => (c.room === room ? { ...c, ...patch } : c)));
}
// Kluby do pokazania: zapisane na urządzeniu + przypięte do konta (te otworzą się po zalogowaniu).
// status: member | pending (czeka na zatwierdzenie) | invited (zaproszenie od założyciela/admina)
export function myClubs() {
  const list = savedClubs().map((c) => ({ room: c.room, name: c.name, nick: c.nick, here: true, status: 'member' }));
  for (const r of savedAccount()?.rooms || []) {
    const st = r.status || 'member';
    const mine = list.find((c) => c.room === r.room);
    if (mine) { if (st !== 'member') mine.status = st; } else list.push({ room: r.room, name: r.name, here: false, status: st });
  }
  return list;
}
// Lista klubów konta po zmianie (z serwera: zatwierdzenie, odrzucenie, zaproszenie).
export function setAccountRooms(rooms) { updateAccount({ rooms: rooms || [] }); }

async function http(method, path, body) {
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(t('Brak połączenia z serwerem.'));
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error ? t(data.error) : t('Błąd serwera ({status})', { status: res.status })), { status: res.status, data });
  return data;
}

export async function registerAccount(nick, password, email) {
  const d = await http('POST', '/api/account/register', { nick, password, email: email || undefined });
  return { saved: rememberAccount(d), rooms: [] };
}
export async function loginAccount(nick, password) {
  const d = await http('POST', '/api/account/login', { nick, password });
  return { saved: rememberAccount(d), rooms: d.rooms || [] };
}
export async function requestPasswordReset(login) { return http('POST', '/api/account/reset-request', { login }); }
export async function resetPassword(token, password) {
  const d = await http('POST', '/api/account/reset', { token, password });
  return { saved: rememberAccount(d), rooms: d.rooms || [] };
}
// Klub przypięty do konta, otwierany na nowym urządzeniu.
export async function restoreRoom(room) {
  const d = await http('POST', `/api/rooms/${encodeURIComponent(room)}/account-login`, { accountToken: accountToken() });
  // zaproszenie przyjęte albo prośba zatwierdzona — od teraz zwykły członek
  setAccountRooms((savedAccount()?.rooms || []).map((r) => (r.room === room ? { ...r, status: 'member' } : r)));
  return rememberClub(room, d);
}
export async function createRoom(name, nick) {
  const d = await http('POST', '/api/rooms', { name, nick, accountToken: accountToken() });
  return rememberClub(d.room, d);
}
// Kod klubu: nazwa i czy potrzebne hasło (błędne kody liczą się do blokady).
export async function lookupClub(code) {
  return http('POST', '/api/rooms/lookup', { code, accountToken: accountToken() });
}
// Zwraca zapisany klub albo { pending, room, name }, gdy klub wymaga zatwierdzenia.
export async function joinClub(code, nick, password) {
  const d = await http('POST', '/api/rooms/join', { code, nick: nick || undefined, password: password || undefined, accountToken: accountToken() });
  if (d.pending) {
    const rooms = (savedAccount()?.rooms || []).filter((r) => r.room !== d.room);
    setAccountRooms([{ room: d.room, name: d.name, status: 'pending' }, ...rooms]);
    return { pending: true, room: d.room, name: d.name };
  }
  return rememberClub(d.room, d);
}
// --- „Moje zapisane gry”: archiwum partii i momentów przy koncie ---
const acctPost = (path, body = {}) => http('POST', '/api/account/' + path, { accountToken: accountToken(), ...body });
export const archive = {
  save: (game) => acctPost('games-save', { game }),
  addMoment: (game, ply, note) => acctPost('moment-add', { game, ply, note }),
  setNote: (id, note) => acctPost('moment-note', { id, note }),
  deleteMoment: (id) => acctPost('moment-delete', { id }),
  list: async () => (await acctPost('games-list')).games,
  get: (id) => acctPost('game-get', { id }),
  deleteGame: (id) => acctPost('game-delete', { id }),
};

// --- logowanie komputera telefonem (QR) ---
export async function qrStart() { return http('POST', '/api/account/qr-start', { ua: navigator.userAgent }); }
// { status: waiting | expired } albo zalogowane konto ({ status: 'approved', saved })
export async function qrPoll(id, secret) {
  const d = await http('POST', '/api/account/qr-poll', { id, secret });
  return d.status === 'approved' ? { status: 'approved', saved: rememberAccount(d) } : d;
}
// Po „wyloguj wszystkie urządzenia” klucze klubów na tym urządzeniu też przestają działać — kluby wrócą z konta.
export function forgetAllClubs() { lsSet(LS_CLUBS, null); }

// --- klucze dostępu (Face ID, odcisk palca, Windows Hello) ---
const b64u = {
  enc(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};
export function passkeySupported() { return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials; }
// Czy urządzenie ma wbudowany czytnik (Face ID, odcisk palca, Windows Hello) — wtedy proponujemy klucz po zalogowaniu.
export async function passkeyPlatform() {
  try { return passkeySupported() && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}
function credJson(c) {
  const r = c.response;
  const out = {
    id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults?.() || {},
    authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: b64u.enc(r.clientDataJSON) },
  };
  if (r.attestationObject) {
    out.response.attestationObject = b64u.enc(r.attestationObject);
    out.response.transports = r.getTransports?.() || [];
  } else {
    out.response.authenticatorData = b64u.enc(r.authenticatorData);
    out.response.signature = b64u.enc(r.signature);
    if (r.userHandle) out.response.userHandle = b64u.enc(r.userHandle);
  }
  return out;
}
function cancelled(e) { return e && (e.name === 'NotAllowedError' || e.name === 'AbortError'); }
export async function passkeyRegister() {
  const { options: o, challengeId } = await http('POST', '/api/account/passkey-reg-options', { accountToken: accountToken() });
  let c;
  try {
    c = await navigator.credentials.create({
      publicKey: {
        ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: b64u.dec(x.id) })),
      },
    });
  } catch (e) {
    if (e?.name === 'InvalidStateError') throw new Error(t('To urządzenie ma już klucz dostępu do tego konta.'));
    if (cancelled(e)) return null;
    throw e;
  }
  return http('POST', '/api/account/passkey-register', { accountToken: accountToken(), challengeId, response: credJson(c) });
}
export async function passkeyLogin() {
  const { options: o, challengeId } = await http('POST', '/api/account/passkey-options', {});
  let c;
  try {
    c = await navigator.credentials.get({
      publicKey: { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((x) => ({ ...x, id: b64u.dec(x.id) })) },
    });
  } catch (e) { if (cancelled(e)) return null; throw e; }
  const d = await http('POST', '/api/account/passkey-login', { challengeId, response: credJson(c) });
  return { saved: rememberAccount(d), rooms: d.rooms || [] };
}

// Link do strony aplikacji z parametrami (bez innych parametrów z bieżącego adresu).
function appLink(params) {
  const u = new URL(location.origin + location.pathname);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function finished(state) { return !!state && state.status !== 'started' && state.status !== 'created'; }

export class RoomsProvider {
  constructor(saved) {
    this.isPublic = saved.room === PUBLIC_CODE;
    this.name = this.isPublic ? 'public' : 'rooms';
    this.isDemo = false;
    this.features = { seek: true, ai: false, friend: false, rooms: true, public: this.isPublic, correspondence: false };
    this.s = saved;
    this.seeks = [];
    this.activeSeek = null; // { opts, id, resolve } — wznawiane po ponownym połączeniu
    this.ws = null;
    this.seq = 0;
    this.pending = new Map(); // reqId → { resolve, reject, msg, retry, timer }
    this.games = new Map(); // gameId → { listeners:Set, state, ended }
    this.challengeWaiters = new Map(); // id → resolve(result)
    this.onEvent = () => {};
    this.eventsWanted = false;
    this.wanted = false;
    this.welcome = null;
    this.members = [];
    this.social = null; // poczekalnia: znajomi, zaproszenia, ostatni rywale
    this.attempt = 0;
    this.readyWaiters = [];
  }

  get roomName() { return this.welcome?.room?.name || this.s?.name || ''; }
  get roomId() { return this.s?.room || ''; }
  get roomCode() { return this.welcome?.room?.code || this.s?.code || ''; } // kod klubu, np. KLUBH-7Q4MX
  get room() { return this.welcome?.room || null; }
  get me() { return this.welcome?.me || null; }
  get lastKey() { return this.isPublic ? 'public' : 'club:' + this.roomId; }
  inviteLink() { return this.isPublic || !this.roomCode ? null : appLink({ klub: this.roomCode }); }
  _save() {
    if (this.isPublic) updateAccount({ name: this.s.name, nick: this.s.nick, secured: this.s.secured, rooms: this.s.rooms });
    else touchClub(this.roomId, { name: this.s.name, nick: this.s.nick, code: this.s.code });
  }
  _forget() { if (this.isPublic) forgetAccount(); else forgetClub(this.roomId); }

  hasToken() { return !!this.s?.token; }
  async login() {}
  async handleRedirect() { return false; }
  async logout() {
    try { if (this.welcome) await this.req('logout', {}, { timeout: 3000 }); } catch {}
    this._shutdown();
    this._forget();
  }

  // --- połączenie -------------------------------------------------------------
  _ensure() {
    this.wanted = true;
    if (!this.listening) {
      // Po powrocie sieci albo aplikacji na pierwszy plan łączymy od razu, bez czekania na kolejną próbę.
      this.listening = true;
      this._wake = () => {
        if (!this.wanted || document.visibilityState === 'hidden') return;
        if (!this.ws) { clearTimeout(this.reconnectTimer); this.attempt = 0; this._connect(); }
      };
      window.addEventListener('online', this._wake);
      document.addEventListener('visibilitychange', this._wake);
    }
    if (!this.ws) this._connect();
  }
  _connect() {
    if (!this.wanted) return;
    const url = apiBase().replace(/^http/, 'ws') + `/api/rooms/${encodeURIComponent(this.s.room)}/ws`;
    let ws;
    try { ws = new WebSocket(url); } catch { this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', token: this.s.token }));
      clearInterval(this.pingTimer);
      // ping co 5 s: serwer szybko zauważa zerwane połączenie (rywal widzi „opuścił partię”)
      this.pingTimer = setInterval(() => { try { ws.send('ping'); } catch {} }, 5000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this._onMessage(m);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      const hadWelcome = !!this.welcome;
      this.welcome = null;
      this._dropPending();
      if (e.code === 4001 || this.authFailed) { this._authLost(); return; }
      if (!this.wanted) return;
      if (hadWelcome || this.attempt > 0) {
        this.onEvent({ type: 'streamStatus', ok: false });
        for (const g of this.games.values()) g.listeners.forEach((fn) => fn({ type: 'connection', ok: false }));
      }
      this._scheduleReconnect();
    };
  }
  _scheduleReconnect() {
    const delay = Math.min(15000, 1000 * 2 ** this.attempt);
    this.attempt++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }
  disconnect() { this._shutdown(); }
  _shutdown() {
    this.wanted = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.welcome = null;
    if (ws) { try { ws.close(1000); } catch {} }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(t('Rozłączono.'))); }
    this.pending.clear();
  }
  _authLost() {
    this._shutdown();
    this._forget();
    const err = new Error(t('Nie rozpoznano Cię w tym pokoju — dołącz ponownie z linku.'));
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
    this.onEvent({ type: 'authLost' });
  }
  // Polecenia bez potwierdzenia przy zerwaniu: błąd; ruchy (retry) wysyłamy ponownie po połączeniu.
  _dropPending() {
    for (const [id, p] of this.pending) {
      if (p.retry) { p.sent = false; continue; }
      clearTimeout(p.timer);
      p.reject(new Error(t('Brak połączenia z serwerem — spróbuj ponownie.')));
      this.pending.delete(id);
    }
  }

  _ready(timeout = 15000) {
    this._ensure();
    if (this.welcome) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this.readyWaiters.push(w);
      setTimeout(() => {
        const i = this.readyWaiters.indexOf(w);
        if (i >= 0) { this.readyWaiters.splice(i, 1); reject(new Error(t('Nie udało się połączyć z serwerem pokoi.'))); }
      }, timeout);
    });
  }

  async req(t, data = {}, { retry = false, timeout = 15000 } = {}) {
    await this._ready();
    return new Promise((resolve, reject) => {
      const reqId = ++this.seq;
      const p = { resolve, reject, msg: { t, reqId, ...data }, retry, sent: false };
      p.timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(t('Serwer nie odpowiada — spróbuj ponownie.'))); }, timeout);
      this.pending.set(reqId, p);
      this._send(p);
    });
  }
  _send(p) {
    if (!this.ws || this.ws.readyState !== 1 || !this.welcome) return;
    try { this.ws.send(JSON.stringify(p.msg)); p.sent = true; } catch {}
  }

  _onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        this.welcome = m;
        this.attempt = 0;
        this.members = m.members || [];
        this.social = m.social || null;
        this.s = { ...this.s, name: m.room.name, nick: m.me.name, code: m.room.code };
        if (this.isPublic) this.s = { ...this.s, secured: !!m.me.hasPassword, rooms: m.me.rooms || [] };
        this._save();
        this.seeks = m.seeks || [];
        this.readyWaiters.splice(0).forEach((w) => w.resolve());
        if (this.activeSeek) this._postSeek(this.activeSeek).catch(() => {});
        if (this.eventsWanted) this._announce();
        for (const [id, g] of this.games) {
          g.listeners.forEach((fn) => fn({ type: 'connection', ok: true }));
          this._send({ msg: { t: 'watch', gameId: id } });
        }
        for (const p of this.pending.values()) if (!p.sent) this._send(p);
        break;
      }
      case 'authFailed':
        this.authFailed = true;
        this.authRemoved = !!m.removed;
        break;
      case 'removed': // usunięty z klubu przez założyciela/administratora
        this.authFailed = true;
        this.authRemoved = true;
        break;
      case 'roomInfo':
        if (this.welcome) { this.welcome.room = m.room; this.welcome.me.role = m.room.role; }
        this.onEvent({ type: 'members' });
        break;
      case 'me': // nowy ranking po partii
        if (this.welcome) this.welcome.me.ratings = m.ratings;
        this.onEvent({ type: 'members' });
        break;
      case 'social':
        this.social = m.social;
        this.onEvent({ type: 'social' });
        break;
      case 'myRooms': // kluby konta po zatwierdzeniu, odrzuceniu albo zaproszeniu
        if (this.isPublic) { this.s = { ...this.s, rooms: m.rooms || [] }; this._save(); }
        this.onEvent({ type: 'myRooms' });
        break;
      case 'presence':
        if (this.social) {
          for (const list of [this.social.friends, this.social.recent]) for (const p of list || []) if (p.id === m.id) p.online = m.online;
        }
        this.onEvent({ type: 'social', presence: m });
        break;
      case 'res': {
        const p = this.pending.get(m.reqId);
        if (!p) return;
        this.pending.delete(m.reqId);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m); else p.reject(new Error(m.error ? t(m.error) : t('Błąd serwera.')));
        break;
      }
      case 'event':
        this.onEvent(m.ev);
        break;
      case 'members':
        this.members = m.members || [];
        if (this.welcome && this.me) {
          const mine = this.members.find((x) => x.id === this.me.id);
          if (mine) this.welcome.me.ratings = mine.ratings;
        }
        this.onEvent({ type: 'members' });
        break;
      case 'seeks':
        this.seeks = m.seeks || [];
        this.onEvent({ type: 'seeks' });
        break;
      case 'seekResult': {
        const a = this.activeSeek;
        if (a && a.id === m.id) { this.activeSeek = null; a.resolve(m.result); }
        break;
      }
      case 'challengeResult': {
        const fn = this.challengeWaiters.get(m.id);
        if (fn) { this.challengeWaiters.delete(m.id); fn(m.result); }
        break;
      }
      case 'game': {
        const g = this.games.get(m.id);
        if (!g) return;
        const msg = m.msg;
        if (msg.type === 'full' || msg.type === 'state') g.state = msg.state;
        g.listeners.forEach((fn) => fn(msg));
        if ((msg.type === 'full' || msg.type === 'state') && finished(msg.state) && !g.ended) {
          g.ended = true;
          g.listeners.forEach((fn) => fn({ type: 'end' }));
        }
        break;
      }
      default: break;
    }
  }

  _announce() {
    const w = this.welcome;
    setTimeout(() => {
      // resetChallenges: lista wyzwań przychodzi w całości (po zerwaniu mogły wygasnąć)
      this.onEvent({ type: 'streamStatus', ok: true, resetChallenges: true });
      for (const c of w.challenges || []) this.onEvent({ type: 'challenge', challenge: c });
    }, 0);
  }

  // --- interfejs dostawcy -----------------------------------------------------------
  async account() {
    await this._ready();
    const me = this.welcome.me;
    const r = me.ratings || {};
    return {
      id: me.id, name: me.name,
      ratings: { blitz: r.blitz?.rating, rapid: r.rapid?.rating, classical: r.classical?.rating },
    };
  }

  async ongoing() { return (await this.req('ongoing')).games; }
  async history() { return (await this.req('history')).games; }
  // panel trenera (założyciel prywatnego pokoju) i zapis partii
  async coachPanel() { return this.req('coachPanel'); }
  async gamePgn(id) { return this.req('gamePgn', { gameId: id }); }
  async roomPgn() { return (await this.req('roomPgn')).pgn; }

  startEvents(onEvent) {
    this.onEvent = onEvent;
    this.eventsWanted = true;
    this._ensure();
    if (this.welcome) this._announce();
  }
  stopEvents() { this.eventsWanted = false; this.onEvent = () => {}; }

  // Szukanie rywala w poczekalni. Serwer paruje sam (to samo tempo, najbliższy ranking).
  // Gdy ktoś już czeka na to tempo, para powstaje od razu: { matched: true }.
  async seek({ time, increment, days, rated }) {
    if (days) throw new Error(t('Partie korespondencyjne w pokojach będą później.'));
    if (this.activeSeek) { this.activeSeek.resolve('canceled'); this.activeSeek = null; }
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const a = { opts: { time, increment, rated: !!rated }, id: null, resolve };
    this.activeSeek = a;
    const r = await this._postSeek(a);
    if (r.matched) return { matched: true, cancel: () => {}, done };
    return {
      cancel: () => {
        if (this.activeSeek === a) this.activeSeek = null;
        a.resolve('canceled');
        if (a.id) this.req('seekCancel', { id: a.id }).catch(() => {});
      },
      done,
    };
  }
  async _postSeek(a) {
    const r = await this.req('seek', a.opts);
    if (r.matched) {
      if (this.activeSeek === a) this.activeSeek = null;
      a.resolve('accepted');
    } else if (this.activeSeek === a) {
      a.id = r.id;
    } else {
      this.req('seekCancel', { id: r.id }).catch(() => {}); // anulowano w trakcie wysyłania
    }
    return r;
  }
  async seekAccept(id) { return (await this.req('seekAccept', { id })).gameId; }
  async challengeAI() { throw new Error(t('W pokoju nie ma gry z komputerem.')); }

  async challenge(memberId, { time, increment, days, rated, color }) {
    if (days) throw new Error(t('Partie korespondencyjne w klubach będą później.'));
    const r = await this.req('challenge', { to: memberId, time, increment, rated: !!rated, color: color || 'random' });
    // rywal już wyzwał nas tak samo (np. obaj kliknęli „Rewanż”) — partia ruszyła od razu
    if (r.matched) return { matched: true, gameId: r.gameId, cancel: () => {}, done: Promise.resolve('accepted') };
    const id = r.id;
    const done = new Promise((resolve) => this.challengeWaiters.set(id, resolve));
    return {
      id,
      cancel: () => { this.req('cancel', { id }).catch(() => {}); },
      done,
    };
  }
  async acceptChallenge(id) { await this.req('accept', { id }); }
  async declineChallenge(id) { await this.req('decline', { id }); }

  streamGame(id, onMsg) {
    let g = this.games.get(id);
    if (!g) { g = { listeners: new Set(), state: null, ended: false }; this.games.set(id, g); }
    g.listeners.add(onMsg);
    this._ensure();
    if (this.welcome) {
      setTimeout(() => onMsg({ type: 'connection', ok: true }), 0);
      this.req('watch', { gameId: id }).catch((e) => onMsg({ type: 'error', message: e.message }));
    }
    return {
      close: () => {
        g.listeners.delete(onMsg);
        if (!g.listeners.size) {
          this.games.delete(id);
          if (this.welcome) this.req('unwatch', { gameId: id }).catch(() => {});
        }
      },
    };
  }

  async move(id, uci) {
    const ply = this.games.get(id)?.state?.moves?.length;
    await this.req('move', { gameId: id, uci, ply }, { retry: true, timeout: 30000 });
  }
  async resign(id) { await this.req('resign', { gameId: id }); }
  async abort(id) { await this.req('abort', { gameId: id }); }
  async draw(id, yes) { await this.req('draw', { gameId: id, yes: !!yes }); }
  async takeback(id, yes) { await this.req('takeback', { gameId: id, yes: !!yes }); }
  async claimVictory(id) { await this.req('claimVictory', { gameId: id }); }
  async claimDraw(id) { await this.req('claimDraw', { gameId: id }); }

  // Konto (tylko poczekalnia ogólna): ustawienie / zmiana hasła i e-maila.
  async setPassword({ password, oldPassword, email }) {
    const r = await this.req('setPassword', { password, oldPassword, email });
    if (this.welcome) Object.assign(this.welcome.me, { hasPassword: r.hasPassword, email: r.email });
    this.s = { ...this.s, secured: !!r.hasPassword };
    this._save();
    return r;
  }
  // Konto (poczekalnia): zatwierdzenie logowania komputera, wylogowanie wszędzie, klucze dostępu.
  qrInfo(code) { return this.req('qrInfo', { code }); }
  qrApprove(code) { return this.req('qrApprove', { code }); }
  logoutAll() { return this.req('logoutAll'); }
  coachNote(gameId, ply, note, to) { return this.req('coachNote', { gameId, ply, note, to }); }
  async friendLinkCreate() { const r = await this.req('friendLinkCreate'); return appLink({}) + '#znajomy=' + r.token; }
  friendLinkInfo(token) { return this.req('friendLinkInfo', { token }); }
  friendLinkUse(token) { return this._social('friendLinkUse', { token }); }
  async ownedClubs() { return (await this.req('ownedClubs')).clubs; }
  // Usunięcie konta (RODO): decisions = { [roomId]: 'delete' | memberId następcy }
  async deleteAccount(password, decisions) {
    await this.req('deleteAccount', { password, decisions });
    this._shutdown(); forgetAccount(); forgetAllClubs();
  }
  async passkeysRemove() { await this.req('passkeysRemove'); if (this.welcome) this.welcome.me.passkeys = 0; }

  // --- zarządzanie klubem (założyciel; usuwanie także administratorzy) ---
  async changeCode() { const r = await this.req('changeCode'); if (this.welcome) this.welcome.room.code = r.code; this.s.code = r.code; this._save(); return r.code; }
  async setRoomPassword(password) { const r = await this.req('setRoomPassword', { password }); if (this.welcome) this.welcome.room.hasPassword = r.hasPassword; return r.hasPassword; }
  async setRole(id, role) { await this.req('setRole', { id, role }); }
  async removeMember(id) { await this.req('removeMember', { id }); }
  // zatwierdzanie członków (założyciel/admin)
  approveRequest(id) { return this.req('approveRequest', { id }); }
  rejectRequest(id) { return this.req('rejectRequest', { id }); }
  unblockMember(id) { return this.req('unblockMember', { id }); }
  inviteNick(nick) { return this.req('inviteNick', { nick }); }
  cancelInvite(id) { return this.req('cancelInvite', { id }); }
  async setApproval(on) { const r = await this.req('setApproval', { on }); if (this.welcome) this.welcome.room.approve = r.approve; return r.approve; }
  async leaveRoom() { await this.req('leaveRoom'); this._shutdown(); this._forget(); }

  // --- znajomi (poczekalnia ogólna) ---
  async _social(t, data) { const r = await this.req(t, data); if (r.social) { this.social = r.social; this.onEvent({ type: 'social' }); } return r; }
  loadSocial() { return this._social('social'); }
  friendInvite(nickOrId) { return this._social('friendInvite', typeof nickOrId === 'object' ? nickOrId : { nick: nickOrId }); }
  friendAccept(id) { return this._social('friendAccept', { id }); }
  friendDecline(id) { return this._social('friendDecline', { id }); }
  friendCancel(id) { return this._social('friendCancel', { id }); }
  friendRemove(id) { return this._social('friendRemove', { id }); }
  block(id) { return this._social('block', { id }); }
  unblock(id) { return this._social('unblock', { id }); }

  gameUrl() { return null; }
  tokenCreateUrl() { return null; }
}

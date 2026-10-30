// Dostawca partii: własne zamknięte pokoje (wariant B) — bez konta Lichess.
// Jedno połączenie WebSocket z serwerem pokoju; serwer liczy zegar i sprawdza ruchy.
import { CONFIG } from './config.js';

// Poczekalnia ogólna to stały pokój o tym kodzie; urządzenie pamięta osobno ją i jeden prywatny pokój.
export const PUBLIC_CODE = 'publiczny';
const LS_ROOM = 'ps_room';
const LS_PUBLIC = 'ps_public';
const keyFor = (room) => (room === PUBLIC_CODE ? LS_PUBLIC : LS_ROOM);

function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function lsSet(key, v) { try { if (v) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key); } catch {} }

function apiBase() { return String(CONFIG.ROOMS_API || '').replace(/\/+$/, ''); }
export function roomsEnabled() { return !!apiBase(); }
function saved(key) { const s = lsGet(key); return s && s.token && s.api === apiBase() ? s : null; }
export function savedRoom() { return saved(LS_ROOM); }
export function savedPublic() { return saved(LS_PUBLIC); }
export function forgetRoom(room) { lsSet(keyFor(room), null); }

async function http(method, path, body) {
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Brak połączenia z serwerem pokoi.');
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `Błąd serwera (${res.status})`);
  return data;
}

function remember(room, d) {
  const s = { api: apiBase(), room, name: d.name, memberId: d.memberId, nick: d.nick, token: d.token };
  if (d.secured) s.secured = true;
  lsSet(keyFor(room), s);
  return s;
}
export async function joinPublic(nick) { return joinRoom(PUBLIC_CODE, nick); }

// --- konto (nick + hasło). Konto = tożsamość w poczekalni ogólnej; pokoje są do niego przypinane. ---
function accountToken() { return savedPublic()?.token || undefined; }
export async function registerAccount(nick, password, email) {
  const d = await http('POST', '/api/account/register', { nick, password, email: email || undefined });
  return { saved: remember(PUBLIC_CODE, { ...d, secured: true }), rooms: [] };
}
export async function loginAccount(nick, password) {
  const d = await http('POST', '/api/account/login', { nick, password });
  return { saved: remember(PUBLIC_CODE, { ...d, secured: true }), rooms: d.rooms || [] };
}
export async function requestPasswordReset(login) { return http('POST', '/api/account/reset-request', { login }); }
export async function resetPassword(token, password) {
  const d = await http('POST', '/api/account/reset', { token, password });
  return { saved: remember(PUBLIC_CODE, { ...d, secured: true }), rooms: d.rooms || [] };
}
// Pokój przypięty do konta, otwierany na nowym urządzeniu.
export async function restoreRoom(code) {
  const d = await http('POST', `/api/rooms/${encodeURIComponent(code)}/account-login`, { accountToken: accountToken() });
  return remember(code, d);
}

export async function roomInfo(code) { return http('GET', `/api/rooms/${encodeURIComponent(code)}`); }
export async function createRoom(name, nick) {
  const d = await http('POST', '/api/rooms', { name, nick, accountToken: accountToken() });
  return remember(d.room, d);
}
export async function joinRoom(code, nick) {
  const body = { nick };
  if (code !== PUBLIC_CODE) body.accountToken = accountToken();
  const d = await http('POST', `/api/rooms/${encodeURIComponent(code)}/join`, body);
  return remember(code, d);
}
export async function claimTransfer(code, transferCode) {
  const d = await http('POST', `/api/rooms/${encodeURIComponent(code)}/transfer`, { code: transferCode });
  return remember(code, d);
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
    this.attempt = 0;
    this.readyWaiters = [];
  }

  get roomName() { return this.welcome?.room?.name || this.s?.name || ''; }
  get roomCode() { return this.s?.room || ''; }
  get me() { return this.welcome?.me || null; }
  inviteLink() { return this.isPublic ? null : appLink({ pokoj: this.roomCode }); }

  hasToken() { return !!this.s?.token; }
  async login() {}
  async handleRedirect() { return false; }
  async logout() {
    try { if (this.welcome) await this.req('logout', {}, { timeout: 3000 }); } catch {}
    this._shutdown();
    forgetRoom(this.s.room);
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
      this.pingTimer = setInterval(() => { try { ws.send('ping'); } catch {} }, 15000);
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
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Rozłączono.')); }
    this.pending.clear();
  }
  _authLost() {
    this._shutdown();
    forgetRoom(this.s.room);
    const err = new Error('Nie rozpoznano Cię w tym pokoju — dołącz ponownie z linku.');
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
    this.onEvent({ type: 'authLost' });
  }
  // Polecenia bez potwierdzenia przy zerwaniu: błąd; ruchy (retry) wysyłamy ponownie po połączeniu.
  _dropPending() {
    for (const [id, p] of this.pending) {
      if (p.retry) { p.sent = false; continue; }
      clearTimeout(p.timer);
      p.reject(new Error('Brak połączenia z serwerem — spróbuj ponownie.'));
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
        if (i >= 0) { this.readyWaiters.splice(i, 1); reject(new Error('Nie udało się połączyć z serwerem pokoi.')); }
      }, timeout);
    });
  }

  async req(t, data = {}, { retry = false, timeout = 15000 } = {}) {
    await this._ready();
    return new Promise((resolve, reject) => {
      const reqId = ++this.seq;
      const p = { resolve, reject, msg: { t, reqId, ...data }, retry, sent: false };
      p.timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error('Serwer nie odpowiada — spróbuj ponownie.')); }, timeout);
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
        const secured = this.isPublic ? !!m.me.hasPassword : this.s.secured;
        if (this.s.name !== m.room.name || this.s.nick !== m.me.name || !!this.s.secured !== !!secured) {
          this.s = { ...this.s, name: m.room.name, nick: m.me.name, secured: !!secured };
          lsSet(keyFor(this.s.room), this.s);
        }
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
        break;
      case 'res': {
        const p = this.pending.get(m.reqId);
        if (!p) return;
        this.pending.delete(m.reqId);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'Błąd serwera.'));
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
    if (days) throw new Error('Partie korespondencyjne w pokojach będą później.');
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
  async challengeAI() { throw new Error('W pokoju nie ma gry z komputerem.'); }

  async challenge(memberId, { time, increment, days, rated, color }) {
    if (days) throw new Error('Partie korespondencyjne w pokojach będą później.');
    const r = await this.req('challenge', { to: memberId, time, increment, rated: !!rated, color: color || 'random' });
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
    lsSet(keyFor(this.s.room), this.s);
    return r;
  }
  // Prywatny pokój: przypięcie tego nicku do konta (żeby wrócić do pokoju po zalogowaniu na innym urządzeniu).
  async linkAccount() {
    await this.req('linkAccount', { accountToken: accountToken() });
    if (this.welcome) this.welcome.me.linked = true;
  }

  async transferLink() {
    const r = await this.req('transferCreate');
    // kod przeniesienia po # (nie trafia do logów serwera stron)
    return { url: `${appLink({ pokoj: this.roomCode })}#przenies=${r.code}`, expiresIn: r.expiresIn };
  }

  gameUrl() { return null; }
  tokenCreateUrl() { return null; }
}

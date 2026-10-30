// Dostawca partii: Lichess (Board API + OAuth PKCE, bez własnego serwera).
import { t } from './i18n.js';
import { CONFIG } from './config.js';
import { readNdjson } from './ndjson.js';

const HOST = CONFIG.LICHESS_HOST;
const SCOPES = 'board:play';
const LS_TOKEN = 'ps_lichess_token';
const LS_VERIFIER = 'ps_pkce_verifier';
const LS_STATE = 'ps_pkce_state';

function ls(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    if (val === null) localStorage.removeItem(key);
    else localStorage.setItem(key, val);
  } catch { return null; }
}

function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 48) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function sha256b64url(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64url(new Uint8Array(d));
}

function redirectUri() { return location.origin + location.pathname; }
function clientId() { return CONFIG.CLIENT_ID || location.host || 'przy-szachownicy'; }

function playerOf(p) {
  if (!p) return { name: '?', rating: null, ai: null };
  if (p.aiLevel) return { name: `Komputer Lichess (poziom ${p.aiLevel})`, rating: null, ai: p.aiLevel, id: null };
  return { name: p.name || p.id, rating: p.rating ?? null, ai: null, id: p.id, title: p.title || null, provisional: !!p.provisional };
}

function normState(s) {
  return {
    moves: s.moves ? s.moves.trim().split(/\s+/).filter(Boolean) : [],
    wtime: s.wtime, btime: s.btime, winc: s.winc, binc: s.binc,
    status: s.status, winner: s.winner || null,
    wdraw: !!s.wdraw, bdraw: !!s.bdraw,
    wtakeback: !!s.wtakeback, btakeback: !!s.btakeback,
  };
}

function normGameInfo(g) {
  const opp = g.opponent || {};
  return {
    id: g.gameId || g.id,
    color: g.color,
    opponent: opp.ai ? { name: `Komputer Lichess (poziom ${opp.ai})`, rating: null, ai: opp.ai }
      : { name: opp.username || opp.id || '?', rating: opp.rating ?? null, ai: null },
    isMyTurn: !!g.isMyTurn,
    speed: g.speed, rated: !!g.rated,
    boardCompatible: g.compat ? g.compat.board !== false : true,
    secondsLeft: g.secondsLeft ?? null,
    lastMove: g.lastMove || '',
    ratingDiff: g.ratingDiff ?? null,
    winner: g.winner || null,
    status: g.status ? g.status.name : null,
  };
}

function tcLabel(tc) {
  if (!tc) return '';
  if (tc.type === 'clock') return tc.show || `${tc.limit / 60}+${tc.increment}`;
  if (tc.type === 'correspondence') return `${tc.daysPerTurn} d/ruch`;
  return 'bez limitu';
}

export class LichessProvider {
  constructor() {
    this.name = 'lichess';
    this.isDemo = false;
    this.token = ls(LS_TOKEN);
    this.eventsCtl = null;
    this.eventsWanted = false;
  }

  // --- logowanie -----------------------------------------------------------
  async login() {
    const verifier = randomString(64);
    const state = randomString(16);
    ls(LS_VERIFIER, verifier);
    ls(LS_STATE, state);
    const challenge = await sha256b64url(verifier);
    const url = new URL(HOST + '/oauth');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId(),
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state,
    }).toString();
    location.href = url.toString();
  }

  // Obsługa powrotu z Lichess (?code=...&state=...). Zwraca true, jeśli był to powrót.
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return false;
    const clean = () => history.replaceState(null, '', location.pathname + location.hash);
    if (params.get('error')) {
      clean();
      throw new Error(params.get('error') === 'access_denied' ? t('Anulowano logowanie.') : t('Logowanie nie powiodło się.'));
    }
    const code = params.get('code');
    const state = params.get('state');
    const verifier = ls(LS_VERIFIER);
    clean();
    if (!verifier || state !== ls(LS_STATE)) throw new Error(t('Logowanie przerwane — spróbuj ponownie.'));
    const res = await fetch(HOST + '/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code, code_verifier: verifier,
        redirect_uri: redirectUri(),
        client_id: clientId(),
      }),
    });
    ls(LS_VERIFIER, null); ls(LS_STATE, null);
    if (!res.ok) throw new Error(t('Nie udało się uzyskać dostępu do konta Lichess.'));
    const data = await res.json();
    this.setToken(data.access_token);
    return true;
  }

  setToken(t) { this.token = t; ls(LS_TOKEN, t); }
  hasToken() { return !!this.token; }

  async logout() {
    this.stopEvents();
    const t = this.token;
    this.setToken(null);
    ls(LS_TOKEN, null);
    if (t) {
      try { await fetch(HOST + '/api/token', { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } }); } catch {}
    }
  }

  // --- HTTP ---------------------------------------------------------------
  async api(path, { method = 'GET', body, signal } = {}) {
    const headers = { Authorization: 'Bearer ' + this.token };
    let payload;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body);
    }
    const res = await fetch(HOST + path, { method, headers, body: payload, signal });
    if (res.status === 401) {
      this.setToken(null);
      const e = new Error(t('Sesja wygasła — zaloguj się ponownie.'));
      e.code = 401;
      throw e;
    }
    if (res.status === 429) throw new Error(t('Lichess prosi o chwilę przerwy (limit zapytań). Spróbuj za minutę.'));
    return res;
  }
  async apiJson(path, opts) {
    const res = await this.api(path, opts);
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(errText(data) || t('Błąd Lichess ({status})', { status: res.status }));
    return data;
  }

  async account() {
    const a = await this.apiJson('/api/account');
    const p = a.perfs || {};
    return {
      id: a.id, name: a.username,
      ratings: {
        rapid: p.rapid?.rating, classical: p.classical?.rating,
        correspondence: p.correspondence?.rating, blitz: p.blitz?.rating,
      },
    };
  }

  async ongoing() {
    const d = await this.apiJson('/api/account/playing?nb=50');
    return (d.nowPlaying || []).map(normGameInfo);
  }

  // --- strumień zdarzeń ---------------------------------------------------
  startEvents(onEvent) {
    this.eventsWanted = true;
    this.onEvent = onEvent;
    this._connectEvents(0);
  }
  stopEvents() {
    this.eventsWanted = false;
    if (this.eventsCtl) this.eventsCtl.abort();
    this.eventsCtl = null;
  }
  async _connectEvents(attempt) {
    if (!this.eventsWanted || !this.token) return;
    const ctl = new AbortController();
    this.eventsCtl = ctl;
    try {
      const res = await this.api('/api/stream/event', { signal: ctl.signal });
      if (!res.ok) throw new Error('' + t('event stream') + ' ' + res.status);
      this.onEvent({ type: 'streamStatus', ok: true });
      attempt = 0;
      await readNdjson(res, (ev) => this._handleEvent(ev));
    } catch (e) {
      if (ctl.signal.aborted) return;
      if (e.code === 401) { this.onEvent({ type: 'authLost' }); return; }
      console.warn('event stream', e);
    }
    if (!this.eventsWanted || ctl.signal.aborted) return;
    this.onEvent({ type: 'streamStatus', ok: false });
    const delay = Math.min(30000, 2000 * 2 ** attempt);
    setTimeout(() => this._connectEvents(attempt + 1), delay);
  }
  _handleEvent(ev) {
    switch (ev.type) {
      case 'gameStart': this.onEvent({ type: 'gameStart', game: normGameInfo(ev.game) }); break;
      case 'gameFinish': this.onEvent({ type: 'gameFinish', game: normGameInfo(ev.game) }); break;
      case 'challenge': {
        const c = ev.challenge;
        if (c.direction === 'out' || (c.challenger && this.userId && c.challenger.id === this.userId)) break;
        this.onEvent({
          type: 'challenge',
          challenge: {
            id: c.id,
            from: c.challenger?.name || c.challenger?.id || '?',
            rating: c.challenger?.rating ?? null,
            speed: c.speed, rated: !!c.rated,
            label: tcLabel(c.timeControl),
            variant: c.variant?.key,
            compatible: (ev.compat ? ev.compat.board !== false : true) && (!c.variant || c.variant.key === 'standard'),
          },
        });
        break;
      }
      case 'challengeCanceled':
      case 'challengeDeclined':
        this.onEvent({ type: 'challengeGone', id: ev.challenge?.id }); break;
      default: break;
    }
  }

  // --- tworzenie partii ---------------------------------------------------
  // Zwraca { cancel(), done: Promise } dla szukania w czasie rzeczywistym
  // albo { correspondence: true } dla ogłoszenia korespondencyjnego.
  // ratingRange: np. '1400-1600' (tylko rywale z tego przedziału)
  async seek({ time, increment, days, rated, ratingRange }) {
    const range = ratingRange ? { ratingRange } : {};
    if (days) {
      await this.apiJson('/api/board/seek', { method: 'POST', body: { rated: String(!!rated), days: String(days), ...range } });
      return { correspondence: true };
    }
    const ctl = new AbortController();
    const done = (async () => {
      const res = await this.api('/api/board/seek', {
        method: 'POST', signal: ctl.signal,
        body: { rated: String(!!rated), time: String(time), increment: String(increment), ...range },
      });
      if (!res.ok) {
        let d = null; try { d = await res.json(); } catch {}
        throw new Error(errText(d) || t('Nie udało się rozpocząć szukania.'));
      }
      await readNdjson(res, () => {});
    })();
    return { cancel: () => ctl.abort(), done };
  }

  // rematchOf: identyfikator poprzedniej partii — rywal widzi u siebie zwykły „Rewanż”
  async challenge(username, { time, increment, days, rated, color, rematchOf }) {
    const body = { rated: String(!!rated), color: color || 'random' };
    if (rematchOf) body.rematchOf = rematchOf;
    if (days) {
      body.days = String(days);
      const d = await this.apiJson('/api/challenge/' + encodeURIComponent(username), { method: 'POST', body });
      return { correspondence: true, id: d.id || d.challenge?.id };
    }
    body['clock.limit'] = String(time * 60);
    body['clock.increment'] = String(increment);
    body.keepAliveStream = 'true';
    const ctl = new AbortController();
    const done = (async () => {
      const res = await this.api('/api/challenge/' + encodeURIComponent(username), { method: 'POST', body, signal: ctl.signal });
      if (!res.ok) {
        let d = null; try { d = await res.json(); } catch {}
        throw new Error(errText(d) || t('Nie udało się wysłać wyzwania.'));
      }
      let result = null;
      await readNdjson(res, (o) => { if (o.done) result = o.done; });
      return result; // 'accepted' | 'declined' | 'canceled' | null
    })();
    return { cancel: () => ctl.abort(), done };
  }

  async challengeAI({ level, time, increment, days, color }) {
    const body = { level: String(level), color: color || 'random' };
    if (days) body.days = String(days);
    else { body['clock.limit'] = String(time * 60); body['clock.increment'] = String(increment); }
    const d = await this.apiJson('/api/challenge/ai', { method: 'POST', body });
    return { gameId: d.id };
  }

  async acceptChallenge(id) { await this.apiJson(`/api/challenge/${id}/accept`, { method: 'POST' }); }
  async declineChallenge(id) { await this.apiJson(`/api/challenge/${id}/decline`, { method: 'POST' }); }

  // --- partia ---------------------------------------------------------------
  streamGame(id, onMsg) {
    let closed = false;
    let ctl = null;
    let finished = false;
    const connect = async (attempt) => {
      if (closed) return;
      ctl = new AbortController();
      try {
        const res = await this.api('/api/board/game/stream/' + id, { signal: ctl.signal });
        if (res.status === 404) { onMsg({ type: 'error', message: 'Nie znaleziono partii.' }); return; }
        if (!res.ok) throw new Error('' + t('game stream') + ' ' + res.status);
        onMsg({ type: 'connection', ok: true });
        attempt = 0;
        await readNdjson(res, (m) => {
          if (m.type === 'gameFull') {
            const st = normState(m.state);
            if (st.status !== 'started' && st.status !== 'created') finished = true;
            onMsg({
              type: 'full', id: m.id,
              white: playerOf(m.white), black: playerOf(m.black),
              speed: m.speed, rated: !!m.rated,
              clock: m.clock ? { initial: m.clock.initial, increment: m.clock.increment } : null,
              daysPerTurn: m.daysPerTurn || null,
              initialFen: m.initialFen || 'startpos',
              state: st,
            });
          } else if (m.type === 'gameState') {
            const st = normState(m);
            if (st.status !== 'started' && st.status !== 'created') finished = true;
            onMsg({ type: 'state', state: st });
          } else if (m.type === 'opponentGone') {
            onMsg({ type: 'opponentGone', gone: !!m.gone, claimWinInSeconds: m.claimWinInSeconds ?? null });
          } else if (m.type === 'chatLine') {
            onMsg({ type: 'chat', user: m.username, text: m.text, room: m.room });
          }
        });
      } catch (e) {
        if (closed || ctl.signal.aborted) return;
        console.warn('game stream', e);
      }
      if (closed || finished) { onMsg({ type: 'end' }); return; }
      onMsg({ type: 'connection', ok: false });
      setTimeout(() => connect(attempt + 1), Math.min(20000, 1500 * 2 ** attempt));
    };
    connect(0);
    return { close: () => { closed = true; if (ctl) ctl.abort(); } };
  }

  async move(id, uci, offeringDraw = false) {
    const q = offeringDraw ? '?offeringDraw=true' : '';
    await this.apiJson(`/api/board/game/${id}/move/${uci}${q}`, { method: 'POST' });
  }
  async resign(id) { await this.apiJson(`/api/board/game/${id}/resign`, { method: 'POST' }); }
  async abort(id) { await this.apiJson(`/api/board/game/${id}/abort`, { method: 'POST' }); }
  async draw(id, yes) { await this.apiJson(`/api/board/game/${id}/draw/${yes ? 'yes' : 'no'}`, { method: 'POST' }); }
  // prośba o cofnięcie / zgoda (yes) albo odmowa (no) — rywal na Lichess musi zaakceptować
  async takeback(id, yes) { await this.apiJson(`/api/board/game/${id}/takeback/${yes ? 'yes' : 'no'}`, { method: 'POST' }); }
  async claimVictory(id) { await this.apiJson(`/api/board/game/${id}/claim-victory`, { method: 'POST' }); }
  async claimDraw(id) { await this.apiJson(`/api/board/game/${id}/claim-draw`, { method: 'POST' }); }
  async chat(id, text) { await this.apiJson(`/api/board/game/${id}/chat`, { method: 'POST', body: { room: 'player', text } }); }

  gameUrl(id) { return `${HOST}/${id}`; }
  tokenCreateUrl() {
    return `${HOST}/account/oauth/token/create?scopes[]=board:play&description=${encodeURIComponent(CONFIG.APP_NAME)}`;
  }
}

function errText(d) {
  if (!d) return '';
  if (typeof d.error === 'string') return translateErr(d.error);
  if (d.error && typeof d.error === 'object') return Object.values(d.error).flat().join(' ');
  return '';
}
function translateErr(s) {
  if (/not your turn/i.test(s)) return t('To nie Twój ruch.');
  if (/illegal|invalid move/i.test(s)) return t('Lichess odrzucił ruch jako niedozwolony.');
  if (/no such user|not found/i.test(s)) return t('Nie znaleziono takiego gracza.');
  return s;
}

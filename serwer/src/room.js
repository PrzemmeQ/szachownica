// Obiekt pokoju (Durable Object): członkowie, wyzwania, partie, ranking.
// Jedyne źródło prawdy dla zegara i legalności ruchów.
import { DurableObject } from 'cloudflare:workers';
import { Chess } from '../../przy-szachownicy/chess.js';
import { rateGame, DEFAULT, PROVISIONAL_RD } from './glicko.js';
import { accountMethods } from './accounts.js';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
// Poczekalnia ogólna: jeden stały pokój dla wszystkich (kod spoza alfabetu losowych kodów).
export const PUBLIC_CODE = 'publiczny';
const PUBLIC_NAME = 'Poczekalnia ogólna';
// Tylko litery łacińskie (z polskimi znakami) i cyfry — bez liter z innych alfabetów,
// które wyglądają tak samo (np. cyrylickie „а”), żeby nikt nie podszył się pod cudzy nick.
const NICK_RE = /^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż _.-]{1,19}$/;
const NICK_ERR = 'Nick: 2–20 znaków — litery (także polskie), cyfry, spacja, _ . -';
const MSG_MAX = 4096; // bajtów na wiadomość WebSocket
const MSG_RATE = { count: 40, ms: 10000 }; // wiadomości na gniazdo w oknie czasu
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const MAX_MEMBERS = 100;
const MAX_MEMBERS_PUBLIC = 1000000;
const PUBLIC_TOP = 20; // w poczekalni ogólnej lista graczy = online + czołówka każdego tempa
const PUBLIC_ONLINE_CAP = 300;
const RATING_SPEEDS = ['blitz', 'rapid', 'classical'];
const ENDED_UNRATED = new Set(['aborted', 'noStart']);

export function randomCode(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}
function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function cleanNick(s) { return String(s ?? '').trim().replace(/\s+/g, ' '); }
function nickKey(s) { return cleanNick(s).toLocaleLowerCase('pl').normalize('NFC'); }

// Tempo wg wzoru Lichess: czas + 40 × dodatek (w sekundach).
export function speedOf(timeMs, incMs) {
  const est = timeMs / 1000 + (40 * incMs) / 1000;
  if (est < 29) return 'ultraBullet';
  if (est < 179) return 'bullet';
  if (est < 479) return 'blitz';
  if (est < 1499) return 'rapid';
  return 'classical';
}
export function ratingSpeed(speed) { return speed === 'rapid' || speed === 'classical' ? speed : 'blitz'; }

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };
const other = (c) => (c === 'white' ? 'black' : 'white');

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.test = env.TEST_MODE === '1';
    // limity czasowe (ms); w trybie testowym krótsze
    this.L = this.test
      ? { noStart: 15000, gone: 2000, claim: 2000, challenge: 10000, sweep: 3000, stale: 8000, hello: 5000, minTime: 0.05 }
      : { noStart: 60000, gone: 30000, claim: 60000, challenge: 120000, sweep: 20000, stale: 45000, hello: 10000, minTime: 10 };
    this.chessCache = new Map();
    this.goneSent = new Map();
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, nick TEXT NOT NULL, nick_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
        joined_at INTEGER NOT NULL, last_seen INTEGER, offline_since INTEGER);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ratings (
        member_id TEXT NOT NULL, speed TEXT NOT NULL, rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
        games INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (member_id, speed));
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, white_id TEXT NOT NULL, black_id TEXT NOT NULL, speed TEXT NOT NULL,
        time_ms INTEGER NOT NULL, inc_ms INTEGER NOT NULL, rated INTEGER NOT NULL,
        status TEXT NOT NULL, winner TEXT, moves TEXT NOT NULL DEFAULT '',
        wtime INTEGER NOT NULL, btime INTEGER NOT NULL, last_move_at INTEGER NOT NULL,
        wdraw INTEGER NOT NULL DEFAULT 0, bdraw INTEGER NOT NULL DEFAULT 0,
        rating_w INTEGER, rating_b INTEGER, prov_w INTEGER, prov_b INTEGER, diff_w INTEGER, diff_b INTEGER,
        created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS games_status ON games (status);
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, time_ms INTEGER NOT NULL,
        inc_ms INTEGER NOT NULL, color TEXT NOT NULL, rated INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seeks (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL, time_ms INTEGER NOT NULL, inc_ms INTEGER NOT NULL,
        rated INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ratings_top ON ratings (speed, rating);
      CREATE TABLE IF NOT EXISTS resets (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_fails (nick_key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (kind TEXT NOT NULL, ip_key TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS limits_at ON limits (kind, at);
      CREATE TABLE IF NOT EXISTS account_rooms (
        member_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT, joined_at INTEGER NOT NULL, PRIMARY KEY (member_id, code));
    `);
    // konta: nowe kolumny (pokoje utworzone przed kontami ich nie mają)
    const cols = new Set(this.sql.exec("SELECT name FROM pragma_table_info('members')").toArray().map((r) => r.name));
    for (const [c, type] of [['pass_hash', 'TEXT'], ['email', 'TEXT'], ['email_key', 'TEXT'], ['account_id', 'TEXT']]) {
      if (!cols.has(c)) this.sql.exec(`ALTER TABLE members ADD COLUMN ${c} ${type}`);
    }
    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS members_email ON members (email_key) WHERE email_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS members_account ON members (account_id);
    `);
  }
  isPublic() { return this.kv('public') === '1'; }
  // pomocnicze dla accounts.js
  fail(msg) { fail(msg); }
  checkNewNick(n) { if (!NICK_RE.test(cleanNick(n))) fail(NICK_ERR); }
  nickKey(s) { return nickKey(s); }
  sha256(s) { return sha256(s); }
  randomCode(n) { return randomCode(n); }

  // --- konto: pytanie poczekalni ogólnej (serwer–serwer) -------------------------
  publicStub() {
    const ns = this.env.JURISDICTION ? this.env.ROOMS.jurisdiction(this.env.JURISDICTION) : this.env.ROOMS;
    return ns.get(ns.idFromName(PUBLIC_CODE));
  }
  async callPublic(action, body) {
    const res = await this.publicStub().fetch('https://pokoj/' + action, {
      method: 'POST', headers: { 'X-Room': PUBLIC_CODE, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.ok ? res.json() : null;
  }
  async accountFromToken(token) {
    if (!token) return null;
    const a = await this.callPublic('acct-verify', { token });
    if (!a) fail('Sesja konta wygasła — zaloguj się ponownie.');
    return a;
  }
  async linkRoomToAccount(memberId, account) {
    this.sql.exec('UPDATE members SET account_id = ? WHERE id = ?', account.id, memberId);
    await this.callPublic('acct-room-add', { accountId: account.id, code: this.kv('code'), name: this.kv('name') });
  }

  // --- pomocnicze: dane --------------------------------------------------
  kv(k, v) {
    if (v === undefined) return this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v ?? null;
    this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, String(v));
  }
  roomExists() { return this.kv('name') !== null; }
  member(id) { return this.sql.exec('SELECT * FROM members WHERE id = ?', id).toArray()[0] || null; }
  allMembers() { return this.sql.exec('SELECT * FROM members ORDER BY joined_at').toArray(); }

  rating(memberId, speed) {
    const r = this.sql.exec('SELECT * FROM ratings WHERE member_id = ? AND speed = ?', memberId, speed).toArray()[0];
    return r || { member_id: memberId, speed, ...DEFAULT, games: 0 };
  }
  saveRating(r) {
    this.sql.exec('INSERT OR REPLACE INTO ratings (member_id, speed, rating, rd, vol, games) VALUES (?, ?, ?, ?, ?, ?)',
      r.member_id, r.speed, r.rating, r.rd, r.vol, r.games);
  }
  ratingsOf(memberId) {
    const out = {};
    for (const sp of RATING_SPEEDS) {
      const r = this.rating(memberId, sp);
      out[sp] = { rating: Math.round(r.rating), rd: Math.round(r.rd), games: r.games, provisional: r.rd > PROVISIONAL_RD };
    }
    return out;
  }

  async addMember(nick, role) {
    const n = cleanNick(nick);
    if (!NICK_RE.test(n)) fail(NICK_ERR);
    const count = this.sql.exec('SELECT COUNT(*) AS c FROM members').one().c;
    if (count >= (this.isPublic() ? MAX_MEMBERS_PUBLIC : MAX_MEMBERS)) fail('Pokój jest pełny.');
    if (this.sql.exec('SELECT 1 FROM members WHERE nick_key = ?', nickKey(n)).toArray().length) fail('Ten nick jest już zajęty w pokoju.');
    let id;
    do { id = randomCode(8); } while (this.member(id));
    this.sql.exec('INSERT INTO members (id, nick, nick_key, role, joined_at, offline_since) VALUES (?, ?, ?, ?, ?, ?)',
      id, n, nickKey(n), role, Date.now(), Date.now());
    const token = await this.issueToken(id);
    return { memberId: id, nick: n, token };
  }
  async issueToken(memberId) {
    const token = randomToken();
    this.sql.exec('INSERT INTO tokens (hash, member_id, created_at) VALUES (?, ?, ?)', await sha256(token), memberId, Date.now());
    return token;
  }

  getGame(id) {
    const g = this.sql.exec('SELECT * FROM games WHERE id = ?', id).toArray()[0];
    if (!g) return null;
    g.moves = g.moves ? g.moves.split(' ') : [];
    return g;
  }
  saveGame(g) {
    this.sql.exec(`UPDATE games SET status = ?, winner = ?, moves = ?, wtime = ?, btime = ?, last_move_at = ?,
      wdraw = ?, bdraw = ?, diff_w = ?, diff_b = ?, ended_at = ? WHERE id = ?`,
    g.status, g.winner, g.moves.join(' '), g.wtime, g.btime, g.last_move_at,
    g.wdraw ? 1 : 0, g.bdraw ? 1 : 0, g.diff_w ?? null, g.diff_b ?? null, g.ended_at ?? null, g.id);
  }
  runningGames() {
    return this.sql.exec("SELECT * FROM games WHERE status = 'started'").toArray().map((g) => {
      g.moves = g.moves ? g.moves.split(' ') : [];
      return g;
    });
  }
  colorOf(g, memberId) {
    if (g.white_id === memberId) return 'white';
    if (g.black_id === memberId) return 'black';
    return null;
  }
  turnOf(g) { return g.moves.length % 2 === 0 ? 'white' : 'black'; }

  chessFor(g) {
    const c = this.chessCache.get(g.id);
    if (c && c.history().length === g.moves.length) return c;
    const chess = new Chess();
    for (const m of g.moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    this.chessCache.set(g.id, chess);
    return chess;
  }

  // --- pomocnicze: kształty danych dla klienta ------------------------------
  liveTimes(g, now) {
    let { wtime, btime } = g;
    if (g.status === 'started' && g.moves.length >= 2) {
      const el = now - g.last_move_at;
      if (this.turnOf(g) === 'white') wtime -= el; else btime -= el;
    }
    return { wtime: Math.max(0, wtime), btime: Math.max(0, btime) };
  }
  stateOf(g, now = Date.now()) {
    const t = this.liveTimes(g, now);
    return {
      moves: [...g.moves], wtime: t.wtime, btime: t.btime, winc: g.inc_ms, binc: g.inc_ms,
      status: g.status, winner: g.winner || null, wdraw: !!g.wdraw, bdraw: !!g.bdraw,
    };
  }
  playerOf(id, rating, prov) {
    const m = this.member(id);
    return { id, name: m ? m.nick : '?', rating: rating ?? null, ai: null, provisional: !!prov };
  }
  fullOf(g) {
    return {
      type: 'full', id: g.id,
      white: this.playerOf(g.white_id, g.rating_w, g.prov_w),
      black: this.playerOf(g.black_id, g.rating_b, g.prov_b),
      speed: g.speed, rated: !!g.rated,
      clock: { initial: g.time_ms, increment: g.inc_ms },
      daysPerTurn: null, initialFen: 'startpos',
      state: this.stateOf(g),
    };
  }
  gameInfo(g, memberId) {
    const color = this.colorOf(g, memberId);
    const oppId = color === 'white' ? g.black_id : g.white_id;
    const opp = this.member(oppId);
    const r = this.rating(oppId, ratingSpeed(g.speed));
    return {
      id: g.id, color,
      opponent: { name: opp ? opp.nick : '?', rating: Math.round(r.rating), ai: null },
      isMyTurn: g.status === 'started' && this.turnOf(g) === color,
      speed: g.speed, rated: !!g.rated, boardCompatible: true,
    };
  }
  challengeOf(ch) {
    const from = this.member(ch.from_id);
    const speed = speedOf(ch.time_ms, ch.inc_ms);
    const r = this.rating(ch.from_id, ratingSpeed(speed));
    return {
      id: ch.id, from: from ? from.nick : '?', fromId: ch.from_id, rating: Math.round(r.rating),
      speed, rated: !!ch.rated, label: `${ch.time_ms / 60000}+${ch.inc_ms / 1000}`, compatible: true,
    };
  }
  membersList() {
    const online = this.onlineIds();
    const shape = (m) => ({ id: m.id, nick: m.nick, role: m.role, online: online.has(m.id), ratings: this.ratingsOf(m.id) });
    if (!this.isPublic()) return this.allMembers().map(shape);
    const ids = new Set([...online].slice(0, PUBLIC_ONLINE_CAP));
    for (const sp of RATING_SPEEDS) {
      for (const r of this.sql.exec('SELECT member_id FROM ratings WHERE speed = ? AND games > 0 ORDER BY rating DESC LIMIT ?', sp, PUBLIC_TOP)) {
        ids.add(r.member_id);
      }
    }
    return [...ids].map((id) => this.member(id)).filter(Boolean).map(shape);
  }
  seeksList() {
    return this.sql.exec('SELECT * FROM seeks ORDER BY created_at').toArray().map((s) => {
      const m = this.member(s.member_id);
      const speed = speedOf(s.time_ms, s.inc_ms);
      return {
        id: s.id, memberId: s.member_id, nick: m ? m.nick : '?', rating: Math.round(this.rating(s.member_id, ratingSpeed(speed)).rating),
        speed, rated: !!s.rated, time: s.time_ms / 60000, increment: s.inc_ms / 1000, label: `${s.time_ms / 60000}+${s.inc_ms / 1000}`,
      };
    });
  }
  broadcastSeeks() { this.toAll({ t: 'seeks', seeks: this.seeksList() }); }

  // --- gniazda ------------------------------------------------------------------
  openSockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1);
  }
  att(ws) { return ws.deserializeAttachment() || {}; }
  onlineIds(except) {
    const s = new Set();
    for (const ws of this.openSockets(except)) { const a = this.att(ws); if (a.memberId) s.add(a.memberId); }
    return s;
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  toMember(memberId, obj) {
    for (const ws of this.openSockets()) if (this.att(ws).memberId === memberId) this.send(ws, obj);
  }
  toAll(obj) {
    for (const ws of this.openSockets()) if (this.att(ws).memberId) this.send(ws, obj);
  }
  toWatchers(g, msg, onlyMember) {
    for (const ws of this.openSockets()) {
      const a = this.att(ws);
      if (!a.memberId || !(a.watch || []).includes(g.id)) continue;
      if (a.memberId !== g.white_id && a.memberId !== g.black_id) continue;
      if (onlyMember && a.memberId !== onlyMember) continue;
      this.send(ws, { t: 'game', id: g.id, msg });
    }
  }
  broadcastState(g) { this.toWatchers(g, { type: 'state', state: this.stateOf(g) }); }
  broadcastMembers() { this.toAll({ t: 'members', members: this.membersList() }); }

  // --- HTTP ---------------------------------------------------------------------
  async fetch(req) {
    const url = new URL(req.url);
    const action = url.pathname.slice(1);
    try {
      if (action === 'ws') return this.acceptSocket(req);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      if (action === 'create') {
        if (this.roomExists()) return json({ error: 'exists' }, 409);
        const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
        if (name.length < 1 || name.length > 40) fail('Nazwa pokoju: 1–40 znaków.');
        const account = await this.accountFromToken(body.accountToken);
        const nick = body.nick || account?.nick;
        if (!NICK_RE.test(cleanNick(nick))) fail(NICK_ERR);
        this.kv('name', name);
        this.kv('code', req.headers.get('X-Room') || '');
        this.kv('created_at', Date.now());
        const m = await this.addMember(nick, 'owner');
        this.kv('owner_id', m.memberId);
        if (account) await this.linkRoomToAccount(m.memberId, account);
        return json({ name, ...m });
      }
      if (!this.roomExists() && req.headers.get('X-Room') === PUBLIC_CODE) {
        this.kv('name', PUBLIC_NAME);
        this.kv('code', PUBLIC_CODE);
        this.kv('public', '1');
        this.kv('created_at', Date.now());
      }
      if (!this.roomExists()) return json({ error: 'Nie ma takiego pokoju. Sprawdź link.' }, 404);
      if (action === 'info') {
        return json({ name: this.kv('name'), members: this.sql.exec('SELECT COUNT(*) AS c FROM members').one().c, public: this.isPublic() });
      }
      // --- konta (tylko poczekalnia ogólna); acct-verify i acct-room-add wołają inne pokoje, nie przeglądarka
      if (action.startsWith('acct-')) {
        if (!this.isPublic()) return json({ error: 'Nie znaleziono.' }, 404);
        const ip = req.headers.get('X-Client-IP') || '';
        if (action === 'acct-register') return json(await this.acctRegister(body, ip));
        if (action === 'acct-login') return json(await this.acctLogin(body, ip));
        if (action === 'acct-limit') {
          const limited = await this.takeLimit(body.kind === 'room' ? 'room' : 'register', ip);
          return limited ? json({ error: limited }, 429) : json({ ok: true });
        }
        if (action === 'acct-reset-request') return json(await this.acctResetRequest(body));
        if (action === 'acct-reset') return json(await this.acctReset(body));
        if (action === 'acct-verify') {
          const a = await this.acctVerify(body.token);
          return a ? json(a) : json({ error: 'Nieznany token.' }, 401);
        }
        if (action === 'acct-room-add') { this.acctAddRoom(body.accountId, body.code, body.name); return json({ ok: true }); }
        return json({ error: 'Nie znaleziono.' }, 404);
      }
      if (action === 'join') {
        // do poczekalni ogólnej tylko z kontem (hasło + limit zakładania); stare nicki bez hasła działają dalej
        if (this.isPublic()) fail('Do szybkiej gry potrzebne jest konto — załóż je w aplikacji.');
        const account = await this.accountFromToken(body.accountToken);
        if (account) {
          // to konto już jest w pokoju — zwróć ten sam nick (np. drugie urządzenie)
          const had = this.sql.exec('SELECT * FROM members WHERE account_id = ?', account.id).toArray()[0];
          if (had) return json({ name: this.kv('name'), memberId: had.id, nick: had.nick, token: await this.issueToken(had.id) });
        }
        const m = await this.addMember(body.nick || account?.nick, 'member');
        if (account) await this.linkRoomToAccount(m.memberId, account);
        if (!this.isPublic()) this.broadcastMembers();
        return json({ name: this.kv('name'), ...m });
      }
      // wejście do pokoju na nowym urządzeniu po zalogowaniu na konto
      if (action === 'account-login') {
        const account = await this.accountFromToken(body.accountToken);
        if (!account) fail('Zaloguj się na konto.');
        const m = this.sql.exec('SELECT * FROM members WHERE account_id = ?', account.id).toArray()[0];
        if (!m) return json({ error: 'Twoje konto nie należy do tego pokoju.' }, 404);
        return json({ name: this.kv('name'), memberId: m.id, nick: m.nick, token: await this.issueToken(m.id) });
      }
      if (action === 'transfer') {
        const hash = await sha256(String(body.code ?? '').toLowerCase());
        const t = this.sql.exec('SELECT * FROM transfers WHERE hash = ?', hash).toArray()[0];
        this.sql.exec('DELETE FROM transfers WHERE hash = ? OR expires_at < ?', hash, Date.now());
        if (!t || t.expires_at < Date.now()) return json({ error: 'Link przeniesienia wygasł albo został już użyty.' }, 410);
        const m = this.member(t.member_id);
        if (!m) return json({ error: 'Nie ma już takiego gracza w pokoju.' }, 410);
        const token = await this.issueToken(m.id);
        return json({ name: this.kv('name'), memberId: m.id, nick: m.nick, token });
      }
      return json({ error: 'Nie znaleziono.' }, 404);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: 'Błąd serwera.' }, 500);
    }
  }

  acceptSocket(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'Oczekiwano WebSocket.' }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ at: Date.now() });
    this.reschedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- WebSocket ----------------------------------------------------------------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MSG_MAX) return;
    // ochrona przed zalewaniem: zbyt wiele wiadomości z jednego gniazda → rozłączenie
    const now = Date.now();
    this.msgRate ||= new WeakMap();
    const r = this.msgRate.get(ws) || { start: now, n: 0 };
    if (now - r.start > MSG_RATE.ms) { r.start = now; r.n = 0; }
    r.n++;
    this.msgRate.set(ws, r);
    if (r.n > MSG_RATE.count) {
      this.send(ws, { t: 'error', message: 'Zbyt wiele poleceń naraz.' });
      try { ws.close(4008, 'rate'); } catch {}
      this.onSocketGone(ws);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const a = this.att(ws);
    if (msg.t === 'hello') { await this.onHello(ws, a, msg); this.reschedule(); return; }
    const reply = (data) => { if (msg.reqId != null) this.send(ws, { t: 'res', reqId: msg.reqId, ...data }); };
    if (!a.memberId) { reply({ ok: false, error: 'Brak autoryzacji.' }); return; }
    try {
      const { closeAfterReply, ...result } = (await this.handle(ws, a, msg)) || {};
      reply({ ok: true, ...result });
      if (closeAfterReply) { try { ws.close(1000, 'logout'); } catch {} }
    } catch (e) {
      if (!(e instanceof UserError)) console.error(e);
      reply({ ok: false, error: e instanceof UserError ? e.message : 'Błąd serwera.' });
    }
    this.reschedule();
  }

  async webSocketClose(ws) { try { ws.close(); } catch {} this.onSocketGone(ws); this.reschedule(); }
  async webSocketError(ws) { this.onSocketGone(ws); this.reschedule(); }

  async onHello(ws, a, msg) {
    const hash = await sha256(String(msg.token ?? ''));
    const row = this.sql.exec('SELECT member_id FROM tokens WHERE hash = ?', hash).toArray()[0];
    const m = row && this.member(row.member_id);
    if (!m) {
      this.send(ws, { t: 'authFailed', message: 'Nie rozpoznano Cię w tym pokoju.' });
      try { ws.close(4001, 'auth'); } catch {}
      return;
    }
    const wasOnline = this.onlineIds(ws).has(m.id);
    ws.serializeAttachment({ ...a, memberId: m.id, th: hash, watch: [] });
    const now = Date.now();
    this.sql.exec('UPDATE members SET offline_since = NULL, last_seen = ? WHERE id = ?', now, m.id);
    if (!wasOnline) {
      for (const g of this.runningGames()) {
        const color = this.colorOf(g, m.id);
        if (!color) continue;
        this.goneSent.delete(g.id + ':' + m.id);
        this.toWatchers(g, { type: 'opponentGone', gone: false, claimWinInSeconds: null }, color === 'white' ? g.black_id : g.white_id);
      }
    }
    this.send(ws, {
      t: 'welcome',
      me: {
        id: m.id, name: m.nick, role: m.role, ratings: this.ratingsOf(m.id),
        linked: !!m.account_id, ...(this.isPublic() ? this.accountInfo(m.id) : {}),
      },
      room: { code: this.kv('code'), name: this.kv('name'), public: this.isPublic() },
      members: this.membersList(),
      seeks: this.seeksList(),
      ongoing: this.runningGames().filter((g) => this.colorOf(g, m.id)).map((g) => this.gameInfo(g, m.id)),
      challenges: this.sql.exec('SELECT * FROM challenges WHERE to_id = ?', m.id).toArray().map((c) => this.challengeOf(c)),
    });
    if (!wasOnline) this.broadcastMembers();
  }

  onSocketGone(ws) {
    const a = this.att(ws);
    if (!a.memberId) return;
    if (this.onlineIds(ws).has(a.memberId)) return;
    const now = Date.now();
    this.sql.exec('UPDATE members SET offline_since = ?, last_seen = ? WHERE id = ?', now, now, a.memberId);
    // szukanie rywala trwa tylko, gdy szukający jest połączony
    const hadSeeks = this.sql.exec('SELECT 1 FROM seeks WHERE member_id = ?', a.memberId).toArray().length;
    if (hadSeeks) { this.sql.exec('DELETE FROM seeks WHERE member_id = ?', a.memberId); this.broadcastSeeks(); }
    this.broadcastMembers();
  }

  async handle(ws, a, msg) {
    const me = a.memberId;
    switch (msg.t) {
      case 'members': return { members: this.membersList() };
      case 'ongoing':
        return { games: this.runningGames().filter((g) => this.colorOf(g, me)).map((g) => this.gameInfo(g, me)) };
      case 'history': return { games: this.history(this.isPublic() ? me : null) };
      case 'setPassword':
        if (!this.isPublic()) fail('Konto ustawiasz w poczekalni ogólnej.');
        return this.acctSetPassword(me, msg, a.th);
      case 'accountInfo':
        if (!this.isPublic()) fail('Konto ustawiasz w poczekalni ogólnej.');
        return this.accountInfo(me);
      case 'linkAccount': {
        if (this.isPublic()) fail('To jest konto.');
        const account = await this.accountFromToken(msg.accountToken);
        if (!account) fail('Zaloguj się na konto.');
        const other = this.sql.exec('SELECT id FROM members WHERE account_id = ? AND id != ?', account.id, me).toArray()[0];
        if (other) fail('To konto ma już inny nick w tym pokoju.');
        await this.linkRoomToAccount(me, account);
        return { linked: true };
      }
      case 'seek': return this.cmdSeek(me, msg);
      case 'seekCancel': return this.cmdSeekCancel(me, msg.id);
      case 'seekAccept': return this.cmdSeekAccept(me, msg.id);
      case 'challenge': return this.cmdChallenge(me, msg);
      case 'cancel': return this.cmdCancel(me, msg.id);
      case 'accept': return this.cmdAccept(me, msg.id);
      case 'decline': return this.cmdDecline(me, msg.id);
      case 'watch': return this.cmdWatch(ws, a, msg.gameId);
      case 'unwatch':
        ws.serializeAttachment({ ...a, watch: (a.watch || []).filter((x) => x !== msg.gameId) });
        return {};
      case 'move': return this.cmdMove(me, msg);
      case 'draw': return this.cmdDraw(me, msg.gameId, !!msg.yes);
      case 'resign': return this.cmdResign(me, msg.gameId);
      case 'abort': return this.cmdAbort(me, msg.gameId);
      case 'claimVictory': return this.cmdClaim(me, msg.gameId, true);
      case 'claimDraw': return this.cmdClaim(me, msg.gameId, false);
      case 'transferCreate': {
        const code = randomCode(12);
        const ttl = 10 * 60000;
        this.sql.exec('DELETE FROM transfers WHERE member_id = ? OR expires_at < ?', me, Date.now());
        this.sql.exec('INSERT INTO transfers (hash, member_id, expires_at) VALUES (?, ?, ?)', await sha256(code), me, Date.now() + ttl);
        return { code, expiresIn: ttl / 1000 };
      }
      case 'logout':
        this.sql.exec('DELETE FROM tokens WHERE hash = ?', a.th);
        ws.serializeAttachment({ at: a.at });
        this.onSocketGone({ deserializeAttachment: () => a });
        return { closeAfterReply: true };
      default: fail('Nieznane polecenie.');
    }
    return {};
  }

  // memberId: tylko partie tego gracza (poczekalnia ogólna), null: wszystkie partie pokoju
  history(memberId) {
    const rows = memberId
      ? this.sql.exec("SELECT * FROM games WHERE status != 'started' AND (white_id = ? OR black_id = ?) ORDER BY ended_at DESC LIMIT 30", memberId, memberId)
      : this.sql.exec("SELECT * FROM games WHERE status != 'started' ORDER BY ended_at DESC LIMIT 30");
    return rows.toArray().map((g) => ({
      id: g.id, white: this.member(g.white_id)?.nick || '?', black: this.member(g.black_id)?.nick || '?',
      whiteId: g.white_id, blackId: g.black_id,
      speed: g.speed, rated: !!g.rated, status: g.status, winner: g.winner || null,
      label: `${g.time_ms / 60000}+${g.inc_ms / 1000}`,
      plies: g.moves ? g.moves.split(' ').length : 0,
      diffW: g.diff_w, diffB: g.diff_b, endedAt: g.ended_at,
    }));
  }

  // --- wyzwania -----------------------------------------------------------------
  tempo(msg) {
    if (msg.days) fail('Partie korespondencyjne w pokojach będą później.');
    const time = Number(msg.time);
    const inc = Number(msg.increment ?? 0);
    // najkrócej 10 minut: przy prawdziwej szachownicy ruch trzeba zagrać i jeszcze wpisać (testy mają krótsze tempa)
    if (time < this.L.minTime) fail(this.test ? 'Nieprawidłowy czas partii.' : 'Najkrótsze tempo to 10 minut — żeby był czas na wpisanie ruchu.');
    if (!(time <= 180)) fail('Nieprawidłowy czas partii.');
    if (!(Number.isInteger(inc) && inc >= 0 && inc <= 180)) fail('Nieprawidłowy dodatek czasu.');
    return { time, inc, time_ms: Math.round(time * 60000), inc_ms: inc * 1000 };
  }

  cmdChallenge(me, msg) {
    const to = String(msg.to ?? '');
    if (to === me) fail('Nie możesz wyzwać samego siebie.');
    if (!this.member(to)) fail('Nie ma takiego gracza w pokoju.');
    const { time, inc } = this.tempo(msg);
    const color = ['white', 'black'].includes(msg.color) ? msg.color : 'random';
    const old = this.sql.exec('SELECT id FROM challenges WHERE from_id = ? AND to_id = ?', me, to).toArray();
    for (const o of old) {
      this.sql.exec('DELETE FROM challenges WHERE id = ?', o.id);
      this.toMember(to, { t: 'event', ev: { type: 'challengeGone', id: o.id } });
    }
    const id = randomCode(10);
    const ch = { id, from_id: me, to_id: to, time_ms: Math.round(time * 60000), inc_ms: inc * 1000, color, rated: msg.rated ? 1 : 0, created_at: Date.now() };
    if (this.isPublic() && !this.onlineIds().has(to)) fail('Ten gracz jest teraz poza poczekalnią.');
    this.sql.exec('INSERT INTO challenges (id, from_id, to_id, time_ms, inc_ms, color, rated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ch.id, ch.from_id, ch.to_id, ch.time_ms, ch.inc_ms, ch.color, ch.rated, ch.created_at);
    this.toMember(to, { t: 'event', ev: { type: 'challenge', challenge: this.challengeOf(ch) } });
    return { id };
  }
  getChallenge(id) { return this.sql.exec('SELECT * FROM challenges WHERE id = ?', String(id ?? '')).toArray()[0] || null; }
  endChallenge(ch, result) {
    this.sql.exec('DELETE FROM challenges WHERE id = ?', ch.id);
    this.toMember(ch.to_id, { t: 'event', ev: { type: 'challengeGone', id: ch.id } });
    this.toMember(ch.from_id, { t: 'challengeResult', id: ch.id, result });
  }
  cmdCancel(me, id) {
    const ch = this.getChallenge(id);
    if (ch && ch.from_id === me) this.endChallenge(ch, 'canceled');
    return {};
  }
  cmdDecline(me, id) {
    const ch = this.getChallenge(id);
    if (ch && ch.to_id === me) this.endChallenge(ch, 'declined');
    return {};
  }
  cmdAccept(me, id) {
    const ch = this.getChallenge(id);
    if (!ch || ch.to_id !== me) fail('To wyzwanie jest już nieaktualne.');
    const challengerWhite = ch.color === 'white' || (ch.color === 'random' && Math.random() < 0.5);
    this.sql.exec('DELETE FROM challenges WHERE id = ?', ch.id);
    this.toMember(ch.to_id, { t: 'event', ev: { type: 'challengeGone', id: ch.id } });
    const g = this.createGame(challengerWhite ? ch.from_id : ch.to_id, challengerWhite ? ch.to_id : ch.from_id, ch.time_ms, ch.inc_ms, ch.rated);
    this.toMember(ch.from_id, { t: 'challengeResult', id: ch.id, result: 'accepted', gameId: g.id });
    return { gameId: g.id };
  }

  // Tworzy partię, zamyka szukania obu graczy i wysyła gameStart.
  createGame(white, black, timeMs, incMs, rated) {
    const speed = speedOf(timeMs, incMs);
    const rw = this.rating(white, ratingSpeed(speed));
    const rb = this.rating(black, ratingSpeed(speed));
    let gid;
    do { gid = randomCode(8); } while (this.getGame(gid));
    const now = Date.now();
    this.sql.exec(`INSERT INTO games (id, white_id, black_id, speed, time_ms, inc_ms, rated, status, moves, wtime, btime,
      last_move_at, rating_w, rating_b, prov_w, prov_b, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', '', ?, ?, ?, ?, ?, ?, ?, ?)`,
    gid, white, black, speed, timeMs, incMs, rated ? 1 : 0, timeMs, timeMs, now,
    Math.round(rw.rating), Math.round(rb.rating), rw.rd > PROVISIONAL_RD ? 1 : 0, rb.rd > PROVISIONAL_RD ? 1 : 0, now);
    const g = this.getGame(gid);
    const seeks = this.sql.exec('SELECT id, member_id FROM seeks WHERE member_id IN (?, ?)', white, black).toArray();
    this.sql.exec('DELETE FROM seeks WHERE member_id IN (?, ?)', white, black);
    for (const pid of [white, black]) this.toMember(pid, { t: 'event', ev: { type: 'gameStart', game: this.gameInfo(g, pid) } });
    for (const s of seeks) this.toMember(s.member_id, { t: 'seekResult', id: s.id, result: 'accepted', gameId: gid });
    if (seeks.length) this.broadcastSeeks();
    return g;
  }

  // --- poczekalnia: szukanie rywala z automatycznym parowaniem ------------------------
  // Para = to samo tempo i ten sam rodzaj (rankingowa / towarzyska); wybieramy najbliższy ranking.
  cmdSeek(me, msg) {
    const { time_ms, inc_ms } = this.tempo(msg);
    const rated = msg.rated ? 1 : 0;
    this.sql.exec('DELETE FROM seeks WHERE member_id = ?', me);
    const sp = ratingSpeed(speedOf(time_ms, inc_ms));
    const mine = this.rating(me, sp).rating;
    const online = this.onlineIds();
    const cands = this.sql.exec('SELECT * FROM seeks WHERE time_ms = ? AND inc_ms = ? AND rated = ? AND member_id != ?',
      time_ms, inc_ms, rated, me).toArray().filter((s) => online.has(s.member_id));
    if (cands.length) {
      cands.sort((a, b) => Math.abs(this.rating(a.member_id, sp).rating - mine) - Math.abs(this.rating(b.member_id, sp).rating - mine)
        || a.created_at - b.created_at);
      const other = cands[0];
      const meWhite = Math.random() < 0.5;
      const g = this.createGame(meWhite ? me : other.member_id, meWhite ? other.member_id : me, time_ms, inc_ms, rated);
      return { matched: true, gameId: g.id };
    }
    const id = randomCode(10);
    this.sql.exec('INSERT INTO seeks (id, member_id, time_ms, inc_ms, rated, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, me, time_ms, inc_ms, rated, Date.now());
    this.broadcastSeeks();
    return { id };
  }
  cmdSeekCancel(me, id) {
    const r = this.sql.exec('SELECT 1 FROM seeks WHERE id = ? AND member_id = ?', String(id ?? ''), me).toArray();
    if (r.length) { this.sql.exec('DELETE FROM seeks WHERE id = ?', String(id)); this.broadcastSeeks(); }
    return {};
  }
  cmdSeekAccept(me, id) {
    const s = this.sql.exec('SELECT * FROM seeks WHERE id = ?', String(id ?? '')).toArray()[0];
    if (!s || !this.onlineIds().has(s.member_id)) fail('Ten gracz już nie szuka rywala.');
    if (s.member_id === me) fail('To Twoje szukanie.');
    const meWhite = Math.random() < 0.5;
    const g = this.createGame(meWhite ? me : s.member_id, meWhite ? s.member_id : me, s.time_ms, s.inc_ms, s.rated);
    return { gameId: g.id };
  }

  // --- partia ---------------------------------------------------------------------
  myGame(me, id) {
    const g = this.getGame(String(id ?? ''));
    if (!g) fail('Nie znaleziono partii.');
    const color = this.colorOf(g, me);
    if (!color) fail('To nie Twoja partia.');
    return { g, color };
  }

  cmdWatch(ws, a, gameId) {
    const { g, color } = this.myGame(a.memberId, gameId);
    const watch = [...new Set([...(a.watch || []), g.id])].slice(-5);
    ws.serializeAttachment({ ...a, watch });
    const now = Date.now();
    if (g.status === 'started') this.checkClock(g, now);
    this.send(ws, { t: 'game', id: g.id, msg: { ...this.fullOf(g), myColor: color } });
    if (g.status === 'started') {
      const gone = this.goneInfo(g, color === 'white' ? g.black_id : g.white_id, now);
      if (gone) this.send(ws, { t: 'game', id: g.id, msg: gone });
    }
    return {};
  }

  // Sprawdza zegar i brak pierwszych ruchów; kończy partię, jeśli trzeba. Zwraca true, gdy partia się skończyła.
  checkClock(g, now) {
    if (g.status !== 'started') return true;
    if (g.moves.length < 2) {
      if (now - g.last_move_at >= this.L.noStart) { this.finish(g, 'noStart', null, now); return true; }
      return false;
    }
    const turn = this.turnOf(g);
    const left = (turn === 'white' ? g.wtime : g.btime) - (now - g.last_move_at);
    if (left > 0) return false;
    if (turn === 'white') g.wtime = 0; else g.btime = 0;
    g.last_move_at = now;
    const winner = other(turn);
    const chess = this.chessFor(g);
    // Bez materiału do zamatowania wygrana na czas jest remisem (jak na Lichess).
    if (!hasMatingMaterial(chess, winner[0])) this.finish(g, 'outoftime', null, now, true);
    else this.finish(g, 'outoftime', winner, now, true);
    return true;
  }

  cmdMove(me, msg) {
    const { g, color } = this.myGame(me, msg.gameId);
    let uci = String(msg.uci ?? '').toLowerCase();
    if (g.status !== 'started') fail('Partia już się zakończyła.');
    if (typeof msg.ply === 'number') {
      if (msg.ply < g.moves.length) {
        if (g.moves[msg.ply] === uci) return { duplicate: true };
        fail('Pozycja w partii się zmieniła — odśwież.');
      }
      if (msg.ply > g.moves.length) fail('Pozycja w partii się zmieniła — odśwież.');
    }
    const now = Date.now();
    if (this.checkClock(g, now) && g.status !== 'started') fail(g.status === 'noStart' ? 'Partia się nie rozpoczęła.' : 'Koniec czasu.');
    if (this.turnOf(g) !== color) fail('To nie Twój ruch.');
    if (!UCI_RE.test(uci)) fail('Ruch niedozwolony.');
    const chess = this.chessFor(g);
    const from = uci.slice(0, 2);
    let to = uci.slice(2, 4);
    const piece = chess.get(from);
    const target = chess.get(to);
    if (piece && piece.type === 'k' && target && target.type === 'r' && target.color === piece.color) {
      to = (to[0] > from[0] ? 'g' : 'c') + from[1];
    }
    let mv = null;
    try { mv = chess.move({ from, to, promotion: uci[4] }); } catch { mv = null; }
    if (!mv) fail('Ruch niedozwolony.');
    uci = mv.from + mv.to + (mv.promotion || '');
    if (g.moves.length >= 2) {
      const el = now - g.last_move_at;
      if (color === 'white') g.wtime = g.wtime - el + g.inc_ms;
      else g.btime = g.btime - el + g.inc_ms;
    }
    g.last_move_at = now;
    g.moves.push(uci);
    g.wdraw = 0; g.bdraw = 0;
    if (chess.isCheckmate()) this.finish(g, 'mate', color, now);
    else if (chess.isStalemate()) this.finish(g, 'stalemate', null, now);
    else if (chess.isDraw()) this.finish(g, 'draw', null, now);
    else { this.saveGame(g); this.broadcastState(g); }
    return {};
  }

  running(me, id) {
    const r = this.myGame(me, id);
    if (r.g.status !== 'started') fail('Partia już się zakończyła.');
    if (this.checkClock(r.g, Date.now())) fail('Partia już się zakończyła.');
    return r;
  }

  cmdDraw(me, id, yes) {
    const { g, color } = this.running(me, id);
    const mine = color === 'white' ? 'wdraw' : 'bdraw';
    const theirs = color === 'white' ? 'bdraw' : 'wdraw';
    if (yes) {
      if (g[theirs]) { this.finish(g, 'draw', null, Date.now()); return {}; }
      if (g.moves.length < 2) fail('Remis można zaproponować po pierwszych ruchach.');
      g[mine] = 1;
    } else {
      g[theirs] = 0;
    }
    this.saveGame(g);
    this.broadcastState(g);
    return {};
  }
  cmdResign(me, id) {
    const { g, color } = this.running(me, id);
    this.finish(g, 'resign', other(color), Date.now());
    return {};
  }
  cmdAbort(me, id) {
    const { g, color } = this.running(me, id);
    const myMoves = color === 'white' ? Math.ceil(g.moves.length / 2) : Math.floor(g.moves.length / 2);
    if (myMoves > 0) fail('Po swoim pierwszym ruchu nie możesz przerwać — możesz się poddać.');
    this.finish(g, 'aborted', null, Date.now());
    return {};
  }
  cmdClaim(me, id, victory) {
    const { g, color } = this.running(me, id);
    const opp = this.member(color === 'white' ? g.black_id : g.white_id);
    const now = Date.now();
    if (this.onlineIds().has(opp.id) || !opp.offline_since || now < opp.offline_since + this.L.gone + this.L.claim) {
      fail('Rywal jest jeszcze w partii.');
    }
    this.finish(g, victory ? 'timeout' : 'draw', victory ? color : null, now);
    return {};
  }

  // Zapisuje koniec partii, liczy ranking, rozsyła stan i zdarzenia.
  finish(g, status, winner, now, clockSettled = false) {
    if (!clockSettled && g.moves.length >= 2) {
      const el = now - g.last_move_at;
      if (this.turnOf(g) === 'white') g.wtime = Math.max(0, g.wtime - el); else g.btime = Math.max(0, g.btime - el);
      g.last_move_at = now;
    }
    g.status = status;
    g.winner = winner;
    g.ended_at = now;
    g.wdraw = 0; g.bdraw = 0;
    if (g.rated && !ENDED_UNRATED.has(status)) {
      const sp = ratingSpeed(g.speed);
      const w = this.rating(g.white_id, sp);
      const b = this.rating(g.black_id, sp);
      const score = winner === 'white' ? 1 : winner === 'black' ? 0 : 0.5;
      const res = rateGame(w, b, score);
      g.diff_w = Math.round(res.white.rating) - Math.round(w.rating);
      g.diff_b = Math.round(res.black.rating) - Math.round(b.rating);
      this.saveRating({ ...w, ...res.white, games: w.games + 1 });
      this.saveRating({ ...b, ...res.black, games: b.games + 1 });
    }
    this.saveGame(g);
    this.chessCache.delete(g.id);
    this.broadcastState(g);
    for (const pid of [g.white_id, g.black_id]) {
      this.toMember(pid, { t: 'event', ev: { type: 'gameFinish', game: this.gameInfo(g, pid) } });
    }
    this.broadcastMembers();
  }

  // --- wyjście rywala -------------------------------------------------------------
  goneInfo(g, oppId, now) {
    if (this.onlineIds().has(oppId)) return null;
    const m = this.member(oppId);
    if (!m || !m.offline_since) return null;
    const t1 = m.offline_since + this.L.gone;
    const t2 = t1 + this.L.claim;
    if (now < t1) return null;
    return { type: 'opponentGone', gone: true, claimWinInSeconds: now >= t2 ? 0 : Math.ceil((t2 - now) / 1000) };
  }

  // --- alarm: zegary, wygasanie wyzwań, wyjście rywala, martwe połączenia ----------
  async alarm() {
    const now = Date.now();
    for (const g of this.runningGames()) {
      if (this.checkClock(g, now)) continue;
      for (const pid of [g.white_id, g.black_id]) {
        const oppId = pid === g.white_id ? g.black_id : g.white_id;
        const info = this.goneInfo(g, oppId, now);
        if (!info) continue;
        const key = g.id + ':' + oppId;
        const stage = info.claimWinInSeconds === 0 ? 2 : 1;
        if (this.goneSent.get(key) === stage) continue;
        this.goneSent.set(key, stage);
        this.toWatchers(g, info, pid);
      }
    }
    for (const ch of this.sql.exec('SELECT * FROM challenges WHERE created_at <= ?', now - this.L.challenge).toArray()) {
      this.endChallenge(ch, 'canceled');
    }
    this.sweepSockets(now);
    this.reschedule();
  }

  sweepSockets(now) {
    for (const ws of this.openSockets()) {
      const a = this.att(ws);
      const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = Math.max(a.at || 0, a.seen || 0, pong ? pong.getTime() : 0);
      const limit = a.memberId ? this.L.stale : this.L.hello;
      if (now - last > limit) {
        try { ws.close(4000, 'timeout'); } catch {}
        this.onSocketGone(ws);
      }
    }
  }

  reschedule() {
    const now = Date.now();
    const times = [];
    const L = this.L;
    const offline = new Map();
    for (const m of this.sql.exec('SELECT id, offline_since FROM members WHERE offline_since IS NOT NULL').toArray()) {
      offline.set(m.id, m.offline_since);
    }
    const running = this.runningGames();
    for (const g of running) {
      if (g.moves.length < 2) times.push(g.last_move_at + L.noStart);
      else times.push(g.last_move_at + (this.turnOf(g) === 'white' ? g.wtime : g.btime));
      for (const pid of [g.white_id, g.black_id]) {
        const since = offline.get(pid);
        if (!since) continue;
        const t1 = since + L.gone;
        const t2 = t1 + L.claim;
        if (now < t1) times.push(t1);
        else if (now < t2) times.push(t2);
      }
    }
    const ch = this.sql.exec('SELECT MIN(created_at) AS t FROM challenges').one().t;
    if (ch != null) times.push(ch + L.challenge);
    // Martwe połączenia sprawdzamy tylko, gdy to ma znaczenie (trwa partia albo ktoś się nie przedstawił),
    // żeby pokój bez partii mógł zasnąć.
    const sockets = this.openSockets();
    const seeking = this.sql.exec('SELECT 1 FROM seeks LIMIT 1').toArray().length;
    if (sockets.length && (running.length || seeking || sockets.some((ws) => !this.att(ws).memberId))) times.push(now + L.sweep);
    if (!times.length) { this.ctx.storage.deleteAlarm(); return; }
    this.ctx.storage.setAlarm(Math.max(now + 50, Math.min(...times)));
  }
}

Object.assign(Room.prototype, accountMethods);

function hasMatingMaterial(chess, c) {
  let minors = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== c || sq.type === 'k') continue;
      if (sq.type === 'p' || sq.type === 'r' || sq.type === 'q') return true;
      minors++;
    }
  }
  return minors >= 2;
}

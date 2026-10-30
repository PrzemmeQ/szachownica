// Obiekt pokoju (Durable Object): członkowie, wyzwania, partie. Jedyne źródło prawdy dla zegara i legalności ruchów.
// Jeden szczególny pokój — poczekalnia ogólna („publiczny”) — prowadzi też konta, wspólny ranking,
// katalog kodów klubów, znajomych i statystyki (accounts.js, clubs.js, social.js, stats.js).
import { DurableObject } from 'cloudflare:workers';
import { Chess } from '../../przy-szachownicy/chess.js';
import { rateGame, DEFAULT, PROVISIONAL_RD } from './glicko.js';
import { accountMethods, hashPassword, verifyPassword } from './accounts.js';
import { statsMethods } from './stats.js';
import { clubMethods } from './clubs.js';
import { socialMethods } from './social.js';
import { memberMethods } from './members.js';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
export const PUBLIC_CODE = 'publiczny';
const PUBLIC_NAME = 'Poczekalnia ogólna';
// Tylko litery łacińskie (z polskimi) i cyfry — bez liter z innych alfabetów, które wyglądają tak samo.
const NICK_RE = /^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż _.-]{1,19}$/;
const NICK_ERR = 'Nick: 2–20 znaków — litery (także polskie), cyfry, spacja, _ . -';
const MSG_MAX = 4096;
const MSG_RATE = { count: 40, ms: 10000 };
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const MAX_MEMBERS = 200;
const MAX_MEMBERS_PUBLIC = 1000000;
const PUBLIC_TOP = 20;
const RATING_SPEEDS = ['rapid', 'classical'];
const ENDED_UNRATED = new Set(['aborted', 'noStart']);
// poddanie, odebranie wygranej i remis przed 5. ruchem (10 półruchów) nie zmieniają rankingu
const SHORT_UNRATED = new Set(['resign', 'timeout', 'draw']);
const SHORT_PLIES = 10;

export function randomCode(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
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
  if (est < 179) return 'bullet';
  if (est < 479) return 'blitz';
  if (est < 1499) return 'rapid';
  return 'classical';
}
// Ranking ma dwa tempa; krótsze (tylko w testach) liczą się jak rapid.
export function ratingSpeed(speed) { return speed === 'classical' ? 'classical' : 'rapid'; }

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };
const other = (c) => (c === 'white' ? 'black' : 'white');

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.test = env.TEST_MODE === '1';
    // Limity czasowe (ms). Zerwane połączenie wykrywamy w ~15 s (ping co 5 s), potem 60 s na powrót rywala.
    this.L = this.test
      ? { noStart: 15000, gone: 2000, claim: 2000, challenge: 10000, sweep: 3000, stale: 8000, hello: 5000, minTime: 0.05 }
      : { noStart: 60000, gone: 3000, claim: 60000, challenge: 120000, sweep: 5000, stale: 15000, hello: 10000, minTime: 10 };
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
        account_id TEXT, joined_at INTEGER NOT NULL, last_seen INTEGER, offline_since INTEGER,
        removed INTEGER NOT NULL DEFAULT 0, pass_hash TEXT, email TEXT, email_key TEXT);
      CREATE INDEX IF NOT EXISTS members_account ON members (account_id);
      CREATE UNIQUE INDEX IF NOT EXISTS members_email ON members (email_key) WHERE email_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ratings (
        member_id TEXT NOT NULL, speed TEXT NOT NULL, rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
        games INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (member_id, speed));
      CREATE INDEX IF NOT EXISTS ratings_top ON ratings (speed, rating);
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, white_id TEXT NOT NULL, black_id TEXT NOT NULL, speed TEXT NOT NULL,
        time_ms INTEGER NOT NULL, inc_ms INTEGER NOT NULL, rated INTEGER NOT NULL,
        status TEXT NOT NULL, winner TEXT, moves TEXT NOT NULL DEFAULT '',
        wtime INTEGER NOT NULL, btime INTEGER NOT NULL, last_move_at INTEGER NOT NULL,
        wdraw INTEGER NOT NULL DEFAULT 0, bdraw INTEGER NOT NULL DEFAULT 0,
        wtakeback INTEGER NOT NULL DEFAULT 0, btakeback INTEGER NOT NULL DEFAULT 0, extra TEXT,
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
      CREATE TABLE IF NOT EXISTS banned_accounts (account_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS resets (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_fails (nick_key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (kind TEXT NOT NULL, ip_key TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS limits_at ON limits (kind, at);
      CREATE TABLE IF NOT EXISTS account_rooms (
        member_id TEXT NOT NULL, room_id TEXT NOT NULL, name TEXT, joined_at INTEGER NOT NULL, PRIMARY KEY (member_id, room_id));
      CREATE TABLE IF NOT EXISTS stat_days (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind));
      CREATE TABLE IF NOT EXISTS stat_players (
        room TEXT NOT NULL, member TEXT NOT NULL, day TEXT NOT NULL, games INTEGER NOT NULL, PRIMARY KEY (room, member, day));
      CREATE TABLE IF NOT EXISTS room_dir (room_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_locks (key TEXT PRIMARY KEY, stage INTEGER NOT NULL, fails INTEGER NOT NULL, banned_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transfer_codes (code6 TEXT PRIMARY KEY, room_id TEXT NOT NULL, code12 TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pair_days (a TEXT NOT NULL, b TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (a, b, day));
      CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (a, b));
      CREATE TABLE IF NOT EXISTS friend_invites (from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE IF NOT EXISTS blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (blocker, blocked));
      CREATE TABLE IF NOT EXISTS invite_log (from_id TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    this.migrateMembers();
  }

  isPublic() { return this.kv('public') === '1'; }
  // pomocnicze dla modułów
  fail(msg) { fail(msg); }
  checkNewNick(n) { if (!NICK_RE.test(cleanNick(n))) fail(NICK_ERR); }
  nickKey(s) { return nickKey(s); }
  sha256(s) { return sha256(s); }
  randomCode(n) { return randomCode(n); }
  rateGameGlicko(w, b, score) { return rateGame(w, b, score); }

  // --- poczekalnia ogólna (serwer–serwer) ---
  publicStub() {
    const ns = this.env.JURISDICTION ? this.env.ROOMS.jurisdiction(this.env.JURISDICTION) : this.env.ROOMS;
    return ns.get(ns.idFromName(PUBLIC_CODE));
  }
  async callPublic(action, body) {
    const res = await this.publicStub().fetch('https://pokoj/' + action, {
      method: 'POST', headers: { 'X-Room': PUBLIC_CODE, 'X-Internal': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.ok ? res.json() : null;
  }
  async accountFromToken(token) {
    if (!token) return null;
    const a = this.isPublic() ? await this.acctVerify(token) : await this.callPublic('acct-verify', { token });
    if (!a) fail('Sesja konta wygasła — zaloguj się ponownie.');
    return a;
  }
  reportStat(ev) {
    if (this.isPublic()) { this.statRecord(ev); return; }
    const p = this.callPublic('acct-stat', ev).catch((e) => console.error('stat', e));
    this.ctx.waitUntil?.(p);
  }

  // --- dane ---
  kv(k, v) {
    if (v === undefined) return this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v ?? null;
    this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, String(v));
  }
  roomExists() { return this.kv('name') !== null; }
  member(id) { return this.sql.exec('SELECT * FROM members WHERE id = ?', id).toArray()[0] || null; }
  activeMembers() { return this.sql.exec('SELECT * FROM members WHERE removed = 0 ORDER BY joined_at').toArray(); }

  // Ranking: w poczekalni tabela kont; w klubie kopia rankingów kont członków (odświeżana z poczekalni).
  rating(id, speed) {
    const r = this.sql.exec('SELECT * FROM ratings WHERE member_id = ? AND speed = ?', id, speed).toArray()[0];
    return r || { member_id: id, speed, ...DEFAULT, games: 0 };
  }
  saveRating(r) {
    this.sql.exec('INSERT OR REPLACE INTO ratings (member_id, speed, rating, rd, vol, games) VALUES (?, ?, ?, ?, ?, ?)',
      r.member_id, r.speed, r.rating, r.rd, r.vol, r.games);
  }
  ratingsOf(id) {
    const out = {};
    for (const sp of RATING_SPEEDS) {
      const r = this.rating(id, sp);
      out[sp] = { rating: Math.round(r.rating), rd: Math.round(r.rd), games: r.games, provisional: r.rd > PROVISIONAL_RD };
    }
    return out;
  }
  accountIdOf(memberId) {
    if (this.isPublic()) return this.member(memberId) ? memberId : null;
    return this.member(memberId)?.account_id || null;
  }
  ratingFor(memberId, sp) {
    const acct = this.accountIdOf(memberId);
    return acct ? this.rating(acct, sp) : null;
  }
  ratingsView(memberId) {
    const acct = this.accountIdOf(memberId);
    return acct ? this.ratingsOf(acct) : null;
  }
  // Klub: odśwież kopie rankingów kont członków (najwyżej co 20 s).
  async refreshRatings(force) {
    if (this.isPublic()) return;
    const last = Number(this.kv('rat_at') || 0);
    if (!force && Date.now() - last < 20000) return;
    this.kv('rat_at', Date.now());
    const ids = this.activeMembers().map((m) => m.account_id).filter(Boolean);
    if (!ids.length) return;
    const all = await this.callPublic('acct-ratings', { ids }).catch(() => null);
    if (all) this.storeRatings(all);
  }
  storeRatings(all) {
    for (const [id, speeds] of Object.entries(all || {})) {
      for (const sp of RATING_SPEEDS) {
        const r = speeds[sp];
        if (r) this.saveRating({ member_id: id, speed: sp, rating: r.rating, rd: r.rd, vol: 0.06, games: r.games });
      }
    }
  }

  async addMember(nick, role, accountId = null) {
    const n = cleanNick(nick);
    if (!NICK_RE.test(n)) fail(NICK_ERR);
    const count = this.sql.exec('SELECT COUNT(*) AS c FROM members WHERE removed = 0').one().c;
    if (count >= (this.isPublic() ? MAX_MEMBERS_PUBLIC : MAX_MEMBERS)) fail('Klub jest pełny.');
    if (this.sql.exec('SELECT 1 FROM members WHERE nick_key = ?', nickKey(n)).toArray().length) {
      fail(this.isPublic() ? 'Ten nick jest już zajęty.' : 'Ten nick jest już zajęty w klubie.');
    }
    let id;
    do { id = randomCode(8); } while (this.member(id));
    this.sql.exec('INSERT INTO members (id, nick, nick_key, role, account_id, joined_at, offline_since) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, n, nickKey(n), role, accountId, Date.now(), Date.now());
    return { memberId: id, nick: n, token: await this.issueToken(id) };
  }
  async issueToken(memberId) {
    const token = randomToken();
    this.sql.exec('INSERT INTO tokens (hash, member_id, created_at) VALUES (?, ?, ?)', await sha256(token), memberId, Date.now());
    return token;
  }

  getGame(id) {
    const g = this.sql.exec('SELECT * FROM games WHERE id = ?', id).toArray()[0];
    return g ? this.hydrate(g) : null;
  }
  hydrate(g) {
    g.moves = g.moves ? g.moves.split(' ') : [];
    try { g.x = JSON.parse(g.extra || '{}'); } catch { g.x = {}; }
    return g;
  }
  saveGame(g) {
    this.sql.exec(`UPDATE games SET status = ?, winner = ?, moves = ?, wtime = ?, btime = ?, last_move_at = ?,
      wdraw = ?, bdraw = ?, wtakeback = ?, btakeback = ?, extra = ?, diff_w = ?, diff_b = ?, ended_at = ? WHERE id = ?`,
    g.status, g.winner, g.moves.join(' '), g.wtime, g.btime, g.last_move_at,
    g.wdraw ? 1 : 0, g.bdraw ? 1 : 0, g.wtakeback ? 1 : 0, g.btakeback ? 1 : 0, JSON.stringify(g.x || {}),
    g.diff_w ?? null, g.diff_b ?? null, g.ended_at ?? null, g.id);
  }
  runningGames() {
    return this.sql.exec("SELECT * FROM games WHERE status = 'started'").toArray().map((g) => this.hydrate(g));
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

  // --- kształty danych dla klienta ---
  liveTimes(g, now) {
    let { wtime, btime } = g;
    if (g.status === 'started' && g.moves.length >= 2) {
      const el = now - g.last_move_at;
      if (this.turnOf(g) === 'white') wtime -= el; else btime -= el;
    }
    return { wtime: Math.max(0, wtime), btime: Math.max(0, btime) };
  }
  // Ile próśb o cofnięcie zostało graczowi dla bieżącego ruchu:
  // dopóki nie usłyszał 2 odmów — 2 prośby na ruch, potem 1.
  takebackLeft(g, color) {
    const t = g.x.tb?.[color] || { ref: 0, ply: -1, n: 0 };
    const allowed = t.ref < 2 ? 2 : 1;
    return t.ply === g.moves.length ? Math.max(0, allowed - t.n) : allowed;
  }
  stateOf(g, now = Date.now()) {
    const t = this.liveTimes(g, now);
    return {
      moves: [...g.moves], wtime: t.wtime, btime: t.btime, winc: g.inc_ms, binc: g.inc_ms,
      status: g.status, winner: g.winner || null, wdraw: !!g.wdraw, bdraw: !!g.bdraw,
      wtakeback: !!g.wtakeback, btakeback: !!g.btakeback,
      takebackLeft: { white: this.takebackLeft(g, 'white'), black: this.takebackLeft(g, 'black') },
    };
  }
  playerOf(id, rating, prov) {
    const m = this.member(id);
    return { id, name: m ? m.nick : '?', rating: rating ?? null, ai: null, provisional: !!prov, account: !!this.accountIdOf(id) };
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
      ratingResult: g.status !== 'started' && g.rated ? { counted: !g.x.unrated, reason: g.x.unrated || null, diffW: g.diff_w, diffB: g.diff_b } : null,
    };
  }
  gameInfo(g, memberId) {
    const color = this.colorOf(g, memberId);
    const oppId = color === 'white' ? g.black_id : g.white_id;
    const opp = this.member(oppId);
    const r = this.ratingFor(oppId, ratingSpeed(g.speed));
    return {
      id: g.id, color,
      opponent: { name: opp ? opp.nick : '?', id: oppId, rating: r ? Math.round(r.rating) : null, ai: null },
      isMyTurn: g.status === 'started' && this.turnOf(g) === color,
      speed: g.speed, rated: !!g.rated, boardCompatible: true,
    };
  }
  challengeOf(ch) {
    const from = this.member(ch.from_id);
    const speed = speedOf(ch.time_ms, ch.inc_ms);
    const r = this.ratingFor(ch.from_id, ratingSpeed(speed));
    return {
      id: ch.id, from: from ? from.nick : '?', fromId: ch.from_id, rating: r ? Math.round(r.rating) : null,
      speed, rated: !!ch.rated, label: `${ch.time_ms / 60000}+${ch.inc_ms / 1000}`, compatible: true,
      time: ch.time_ms / 60000, increment: ch.inc_ms / 1000,
      color: ch.color === 'random' ? 'random' : other(ch.color), // kolor przyjmującego
    };
  }
  memberShape(m, online) {
    return { id: m.id, nick: m.nick, role: m.role, online: online.has(m.id), account: !!this.accountIdOf(m.id), ratings: this.ratingsView(m.id) };
  }
  // Klub: wszyscy członkowie. Poczekalnia: czołówka każdego tempa (+ ja) — bez listy wszystkich obecnych.
  membersList(forId) {
    const online = this.onlineIds();
    if (!this.isPublic()) return this.activeMembers().map((m) => this.memberShape(m, online));
    const ids = new Set(forId ? [forId] : []);
    for (const sp of RATING_SPEEDS) {
      for (const r of this.sql.exec('SELECT member_id FROM ratings WHERE speed = ? AND games > 0 ORDER BY rating DESC LIMIT ?', sp, PUBLIC_TOP)) {
        ids.add(r.member_id);
      }
    }
    const visible = forId ? this.presenceAudience(forId) : new Set();
    return [...ids].map((id) => this.member(id)).filter(Boolean)
      .map((m) => ({ ...this.memberShape(m, online), online: (m.id === forId || visible.has(m.id)) && online.has(m.id) }));
  }
  seeksList() {
    return this.sql.exec('SELECT * FROM seeks ORDER BY created_at').toArray().map((s) => {
      const m = this.member(s.member_id);
      const speed = speedOf(s.time_ms, s.inc_ms);
      const r = this.ratingFor(s.member_id, ratingSpeed(speed));
      return {
        id: s.id, memberId: s.member_id, nick: m ? m.nick : '?', rating: r ? Math.round(r.rating) : null,
        speed, rated: !!s.rated, time: s.time_ms / 60000, increment: s.inc_ms / 1000, label: `${s.time_ms / 60000}+${s.inc_ms / 1000}`,
      };
    });
  }
  broadcastSeeks() { this.toAll({ t: 'seeks', seeks: this.seeksList() }); }
  roomInfo(memberId) {
    const m = this.member(memberId);
    const manager = m && (m.role === 'owner' || m.role === 'admin');
    return {
      code: this.kv('code'), name: this.kv('name'), public: this.isPublic(), id: this.kv('room_id'),
      hasPassword: !!this.kv('pass_hash'), role: m?.role || 'member', canManage: !!manager,
      approve: this.isPublic() ? false : this.approvalOn(),
      ...(manager && !this.isPublic() ? { requests: this.requestsList().length } : {}),
    };
  }

  // --- gniazda ---
  openSockets(except) { return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1); }
  att(ws) { return ws.deserializeAttachment() || {}; }
  onlineIds(except) {
    const s = new Set();
    for (const ws of this.openSockets(except)) { const a = this.att(ws); if (a.memberId) s.add(a.memberId); }
    return s;
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  toMember(memberId, obj) { for (const ws of this.openSockets()) if (this.att(ws).memberId === memberId) this.send(ws, obj); }
  toAll(obj) { for (const ws of this.openSockets()) if (this.att(ws).memberId) this.send(ws, obj); }
  toWatchers(g, msg, onlyMember) {
    for (const ws of this.openSockets()) {
      const a = this.att(ws);
      if (!a.memberId || !(a.watch || []).includes(g.id)) continue;
      if (a.memberId !== g.white_id && a.memberId !== g.black_id && !this.isCoach(a.memberId)) continue;
      if (onlyMember && a.memberId !== onlyMember) continue;
      this.send(ws, { t: 'game', id: g.id, msg });
    }
  }
  broadcastState(g) { this.toWatchers(g, { type: 'state', state: this.stateOf(g) }); }
  // Klub: lista członków wszystkim. Poczekalnia: obecność tylko dla znajomych i ostatnich rywali.
  broadcastMembers() {
    if (!this.isPublic()) { this.toAll({ t: 'members', members: this.membersList() }); return; }
  }
  presenceChanged(id, online) {
    if (!this.isPublic()) { this.broadcastMembers(); return; }
    for (const pid of this.presenceAudience(id)) this.toMember(pid, { t: 'presence', id, online });
  }

  // --- HTTP ---
  async fetch(req) {
    const url = new URL(req.url);
    const action = url.pathname.slice(1);
    const internal = req.headers.get('X-Internal') === '1';
    try {
      if (action === 'ws') return this.acceptSocket(req);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      if (action === 'create') {
        if (this.roomExists()) return json({ error: 'exists' }, 409);
        const roomId = req.headers.get('X-Room') || '';
        const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
        if (name.length < 1 || name.length > 40) fail('Nazwa klubu: 1–40 znaków.');
        const account = await this.accountFromToken(body.accountToken);
        if (!account) fail('Klub zakłada się z kontem — zaloguj się albo załóż konto.');
        const nick = body.nick || account.nick;
        if (!NICK_RE.test(cleanNick(nick))) fail(NICK_ERR);
        const reg = await this.callPublic('acct-room-register', { roomId, name });
        if (!reg?.code) fail('Nie udało się nadać kodu klubu. Spróbuj ponownie.');
        this.kv('name', name);
        this.kv('room_id', roomId);
        this.kv('code', reg.code);
        this.kv('created_at', Date.now());
        this.kv('approve', '1'); // nowi członkowie czekają na zatwierdzenie
        const m = await this.addMember(nick, 'owner', account.id);
        this.kv('owner_id', m.memberId);
        this.reportStat({ kind: 'room' });
        await this.callPublic('acct-room-add', { accountId: account.id, roomId, name });
        return json({ name, code: reg.code, ...m });
      }
      if (!this.roomExists() && req.headers.get('X-Room') === PUBLIC_CODE) {
        this.kv('name', PUBLIC_NAME);
        this.kv('code', PUBLIC_CODE);
        this.kv('room_id', PUBLIC_CODE);
        this.kv('public', '1');
        this.kv('created_at', Date.now());
      }
      if (!this.roomExists()) return json({ error: 'Nie ma takiego klubu.' }, 404);
      if (action.startsWith('acct-')) {
        if (!this.isPublic()) return json({ error: 'Nie znaleziono.' }, 404);
        return json(await this.publicAction(action, body, req, internal));
      }
      // tylko z poczekalni ogólnej (sprawdzenie kodu i blokady jest tam)
      if (action === 'info' && internal) return json({ name: this.kv('name'), needsPassword: !!this.kv('pass_hash') });
      if (action === 'join' && internal) return await this.httpJoin(body);
      if (action === 'account-login') {
        const account = await this.accountFromToken(body.accountToken);
        if (!account) fail('Zaloguj się na konto.');
        const r = await this.accountEnter(account);
        return json(r.body, r.status);
      }
      if (action === 'transfer') {
        const hash = await sha256(String(body.code ?? '').toLowerCase());
        const t = this.sql.exec('SELECT * FROM transfers WHERE hash = ?', hash).toArray()[0];
        this.sql.exec('DELETE FROM transfers WHERE hash = ? OR expires_at < ?', hash, Date.now());
        if (!t || t.expires_at < Date.now()) return json({ error: 'Kod przeniesienia wygasł albo został już użyty.' }, 410);
        const m = this.member(t.member_id);
        if (!m || m.removed) return json({ error: 'Nie ma już takiego gracza w klubie.' }, 410);
        return json({ name: this.kv('name'), code: this.kv('code'), memberId: m.id, nick: m.nick, token: await this.issueToken(m.id) });
      }
      return json({ error: 'Nie znaleziono.' }, 404);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: 'Błąd serwera.' }, 500);
    }
  }

  // Akcje poczekalni ogólnej. Wewnętrzne (wołane przez inne pokoje) wymagają nagłówka X-Internal,
  // którego Worker nigdy nie przekazuje od przeglądarki.
  async publicAction(action, body, req, internal) {
    const ip = req.headers.get('X-Client-IP') || '';
    switch (action) {
      case 'acct-register': return this.acctRegister(body, ip);
      case 'acct-login': return this.acctLogin(body, ip);
      case 'acct-reset-request': return this.acctResetRequest(body);
      case 'acct-reset': return this.acctReset(body);
      case 'acct-club-lookup': return this.clubLookup(body, ip);
      case 'acct-club-join': return this.clubJoin(body, ip);
      case 'acct-transfer-claim': return this.clubTransferClaim(body, ip);
      case 'acct-limit': {
        const limited = await this.takeLimit(body.kind === 'room' ? 'room' : 'register', ip);
        if (limited) fail(limited);
        return { ok: true };
      }
      case 'acct-stats': {
        const err = await this.statsAuth(req.headers.get('X-Stats-Key'), ip);
        if (err) fail(err.msg);
        return this.statsSummary();
      }
      default: break;
    }
    if (!internal) fail('Nie znaleziono.');
    switch (action) {
      case 'acct-verify': {
        const a = await this.acctVerify(body.token);
        if (!a) fail('Nieznany token.');
        return a;
      }
      case 'acct-room-register': return { code: this.clubNewCode(String(body.roomId), String(body.name || '')) };
      case 'acct-room-recode': {
        this.sql.exec('DELETE FROM room_dir WHERE room_id = ?', String(body.roomId));
        return { code: this.clubNewCode(String(body.roomId), String(body.name || '')) };
      }
      case 'acct-room-add': this.acctAddRoom(body.accountId, body.roomId, body.name); return { ok: true };
      case 'acct-room-remove': this.acctRemoveRoom(body.accountId, body.roomId); return { ok: true };
      case 'acct-room-status': this.acctRoomStatus(body); return { ok: true };
      case 'acct-find': return this.acctFind(body.nick);
      case 'acct-ratings': return this.acctRatings(body.ids);
      case 'acct-rate': return this.acctRate(body);
      case 'acct-stat': this.statRecord(body); return { ok: true };
      case 'acct-transfer6': return { code6: this.clubTransferRegister(String(body.roomId), String(body.code12)) };
      default: fail('Nie znaleziono.');
    }
    return {};
  }

  // Dołączenie do klubu (wywołuje poczekalnia po sprawdzeniu blokady). Kod i hasło sprawdza pokój.
  async httpJoin(body) {
    if (this.isPublic()) fail('Do szybkiej gry potrzebne jest konto.');
    if (String(body.code || '') !== this.kv('code')) return json({ error: 'Zły kod.', wrongPassword: true }, 403);
    const ph = this.kv('pass_hash');
    if (ph && !(await verifyPassword(String(body.password || ''), ph))) {
      return json({ error: 'Złe hasło klubu.', wrongPassword: true, needsPassword: true }, 403);
    }
    if (!body.accountId) fail('Do klubu dołączasz z kontem — zaloguj się albo załóż konto.');
    return json(await this.joinWithAccount(String(body.accountId), body.accountNick, body.nick));
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

  // --- WebSocket ---
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MSG_MAX) return;
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
    if (!m || m.removed) {
      this.send(ws, { t: 'authFailed', message: m?.removed ? 'Zostałeś usunięty z tego klubu.' : 'Nie rozpoznano Cię w tym klubie.', removed: !!m?.removed });
      try { ws.close(4001, 'auth'); } catch {}
      return;
    }
    await this.refreshRatings();
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
        id: m.id, name: m.nick, role: m.role, ratings: this.ratingsView(m.id), account: !!this.accountIdOf(m.id),
        linked: !!m.account_id, ...(this.isPublic() ? { ...this.accountInfo(m.id), rooms: this.acctRooms(m.id) } : {}),
      },
      room: this.roomInfo(m.id),
      members: this.membersList(m.id),
      seeks: this.seeksList(),
      social: this.isPublic() ? this.socialOf(m.id) : null,
      ongoing: this.runningGames().filter((g) => this.colorOf(g, m.id)).map((g) => this.gameInfo(g, m.id)),
      challenges: this.sql.exec('SELECT * FROM challenges WHERE to_id = ?', m.id).toArray().map((c) => this.challengeOf(c)),
    });
    if (!wasOnline) this.presenceChanged(m.id, true);
  }

  onSocketGone(ws) {
    const a = this.att(ws);
    if (!a.memberId) return;
    if (this.onlineIds(ws).has(a.memberId)) return;
    const now = Date.now();
    this.sql.exec('UPDATE members SET offline_since = ?, last_seen = ? WHERE id = ?', now, now, a.memberId);
    const hadSeeks = this.sql.exec('SELECT 1 FROM seeks WHERE member_id = ?', a.memberId).toArray().length;
    if (hadSeeks) { this.sql.exec('DELETE FROM seeks WHERE member_id = ?', a.memberId); this.broadcastSeeks(); }
    this.presenceChanged(a.memberId, false);
  }

  async handle(ws, a, msg) {
    const me = a.memberId;
    const pub = this.isPublic();
    switch (msg.t) {
      case 'members': return { members: this.membersList(me) };
      case 'ongoing': return { games: this.runningGames().filter((g) => this.colorOf(g, me)).map((g) => this.gameInfo(g, me)) };
      case 'history': return { games: this.history(pub ? me : null) };
      case 'gamePgn': return this.pgnOf(this.viewableGame(me, msg.gameId).g);
      case 'roomInfo': return this.roomInfo(me);
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
      case 'takeback': return this.cmdTakeback(me, msg.gameId, !!msg.yes);
      case 'resign': return this.cmdResign(me, msg.gameId);
      case 'abort': return this.cmdAbort(me, msg.gameId);
      case 'claimVictory': return this.cmdClaim(me, msg.gameId, true);
      case 'claimDraw': return this.cmdClaim(me, msg.gameId, false);
      case 'transferCreate': {
        const code = randomCode(12);
        const ttl = 10 * 60000;
        this.sql.exec('DELETE FROM transfers WHERE member_id = ? OR expires_at < ?', me, Date.now());
        this.sql.exec('INSERT INTO transfers (hash, member_id, expires_at) VALUES (?, ?, ?)', await sha256(code), me, Date.now() + ttl);
        const roomId = this.kv('room_id');
        const r6 = pub ? { code6: this.clubTransferRegister(roomId, code) } : await this.callPublic('acct-transfer6', { roomId, code12: code });
        return { code, code6: r6?.code6 || null, expiresIn: ttl / 1000 };
      }
      case 'logout':
        this.sql.exec('DELETE FROM tokens WHERE hash = ?', a.th);
        ws.serializeAttachment({ at: a.at });
        this.onSocketGone({ deserializeAttachment: () => a });
        return { closeAfterReply: true };
      default: break;
    }
    if (pub) {
      switch (msg.t) {
        case 'setPassword': return this.acctSetPassword(me, msg, a.th);
        case 'accountInfo': return this.accountInfo(me);
        case 'myRooms': return { rooms: this.acctRooms(me) };
        case 'social': return { social: this.socialOf(me) };
        case 'friendInvite': return this.cmdFriendInvite(me, msg);
        case 'friendAccept': return this.cmdFriendAccept(me, msg.id);
        case 'friendDecline': return this.cmdFriendDecline(me, msg.id);
        case 'friendCancel': return this.cmdFriendCancel(me, msg.id);
        case 'friendRemove': return this.cmdFriendRemove(me, msg.id);
        case 'block': return this.cmdBlock(me, msg.id);
        case 'unblock': return this.cmdUnblock(me, msg.id);
        default: fail('Nieznane polecenie.');
      }
    }
    switch (msg.t) {
      case 'coachPanel': this.needManager(me); return this.coachPanel();
      case 'roomPgn':
        this.needManager(me);
        return {
          pgn: this.sql.exec("SELECT * FROM games WHERE status NOT IN ('started', 'aborted', 'noStart') ORDER BY ended_at DESC LIMIT 300")
            .toArray().map((g) => this.pgnOf(this.hydrate(g)).pgn).join('\n\n'),
        };
      case 'linkAccount': {
        const account = await this.accountFromToken(msg.accountToken);
        if (!account) fail('Zaloguj się na konto.');
        if (this.sql.exec('SELECT 1 FROM members WHERE account_id = ? AND id != ? AND removed = 0', account.id, me).toArray().length) {
          fail('To konto ma już inny nick w tym klubie.');
        }
        this.sql.exec('UPDATE members SET account_id = ? WHERE id = ?', account.id, me);
        await this.callPublic('acct-room-add', { accountId: account.id, roomId: this.kv('room_id'), name: this.kv('name') });
        await this.refreshRatings(true);
        this.broadcastMembers();
        return { linked: true };
      }
      case 'changeCode': {
        this.needOwner(me);
        const r = await this.callPublic('acct-room-recode', { roomId: this.kv('room_id'), name: this.kv('name') });
        if (!r?.code) fail('Nie udało się zmienić kodu.');
        this.kv('code', r.code);
        return { code: r.code };
      }
      case 'setRoomPassword': {
        this.needOwner(me);
        const p = String(msg.password || '');
        if (!p) { this.sql.exec("DELETE FROM kv WHERE k = 'pass_hash'"); return { hasPassword: false }; }
        if (p.length < 4 || p.length > 100) fail('Hasło klubu: 4–100 znaków.');
        this.kv('pass_hash', await hashPassword(p, this.test ? 1000 : 100000));
        return { hasPassword: true };
      }
      case 'setRole': {
        this.needOwner(me);
        const t = this.member(String(msg.id || ''));
        if (!t || t.removed || t.role === 'owner') fail('Nie można zmienić roli tego gracza.');
        const role = msg.role === 'admin' ? 'admin' : 'member';
        this.sql.exec('UPDATE members SET role = ? WHERE id = ?', role, t.id);
        this.broadcastMembers();
        this.toMember(t.id, { t: 'roomInfo', room: this.roomInfo(t.id) });
        return {};
      }
      case 'removeMember': return this.cmdRemoveMember(me, String(msg.id || ''));
      case 'approveRequest': return this.cmdApprove(me, msg.id);
      case 'rejectRequest': return this.cmdReject(me, msg.id);
      case 'unblockMember': return this.cmdUnblockMember(me, msg.id);
      case 'inviteNick': return this.cmdInviteNick(me, msg.nick);
      case 'cancelInvite': return this.cmdCancelInvite(me, msg.id);
      case 'setApproval': return this.cmdSetApproval(me, !!msg.on);
      case 'leaveRoom': {
        const m = this.member(me);
        if (m.role === 'owner') fail('Założyciel nie może opuścić klubu.');
        this.dropMember(m, false);
        return { closeAfterReply: true };
      }
      default: fail('Nieznane polecenie.');
    }
    return {};
  }

  // --- zarządzanie klubem ---
  isCoach(memberId) {
    if (this.isPublic()) return false;
    const role = this.member(memberId)?.role;
    return role === 'owner' || role === 'admin';
  }
  needManager(me) { if (!this.isCoach(me)) fail('To mogą zrobić tylko założyciel i administratorzy klubu.'); }
  needOwner(me) { if (this.member(me)?.role !== 'owner') fail('To może zrobić tylko założyciel klubu.'); }
  cmdRemoveMember(me, id) {
    this.needManager(me);
    const actor = this.member(me);
    const t = this.member(id);
    if (!t || t.removed) fail('Nie ma takiego gracza w klubie.');
    if (t.role === 'owner') fail('Założyciela nie można usunąć.');
    if (t.role === 'admin' && actor.role !== 'owner') fail('Administratora może usunąć tylko założyciel.');
    this.dropMember(t, true);
    return {};
  }
  // Usunięcie (ban = nie może wrócić na to konto) albo samodzielne wyjście z klubu.
  dropMember(m, ban) {
    // nick zostaje w historii partii, ale zwalnia się dla innych (nick_key z dopiskiem)
    this.sql.exec('UPDATE members SET removed = 1, role = ?, nick_key = ? WHERE id = ?', 'member', `${m.nick_key}#${m.id}`, m.id);
    this.sql.exec('DELETE FROM tokens WHERE member_id = ?', m.id);
    if (ban && m.account_id) this.sql.exec('INSERT OR REPLACE INTO banned_accounts (account_id, at, nick) VALUES (?, ?, ?)', m.account_id, Date.now(), m.nick);
    for (const ch of this.sql.exec('SELECT * FROM challenges WHERE from_id = ? OR to_id = ?', m.id, m.id).toArray()) this.endChallenge(ch, 'canceled');
    this.sql.exec('DELETE FROM seeks WHERE member_id = ?', m.id);
    if (m.account_id) {
      const p = this.callPublic('acct-room-remove', { accountId: m.account_id, roomId: this.kv('room_id') }).catch(() => null);
      this.ctx.waitUntil?.(p);
    }
    if (ban) {
      this.toMember(m.id, { t: 'removed', ban });
      for (const ws of this.openSockets()) if (this.att(ws).memberId === m.id) { try { ws.close(4003, 'removed'); } catch {} }
    } else {
      // samodzielne wyjście: odpowiedź „OK” idzie najpierw, gniazdo zamyka się po niej (closeAfterReply)
      for (const ws of this.openSockets()) if (this.att(ws).memberId === m.id) ws.serializeAttachment({ at: Date.now() });
    }
    this.broadcastMembers();
  }

  // Zapis partii w PGN i ruchy SAN.
  pgnOf(g) {
    const chess = new Chess();
    const san = [];
    for (const m of g.moves) {
      try { san.push(chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }).san); } catch { break; }
    }
    const result = g.status === 'started' || ENDED_UNRATED.has(g.status) ? '*' : g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '1/2-1/2';
    const date = new Date(g.created_at).toISOString().slice(0, 10).replace(/-/g, '.');
    const tag = (k, v) => `[${k} "${String(v ?? '').replace(/["\\]/g, '')}"]`;
    const head = [
      tag('Event', this.kv('name') || 'Przy Szachownicy'), tag('Site', 'Przy Szachownicy'), tag('Date', date),
      tag('White', this.member(g.white_id)?.nick || '?'), tag('Black', this.member(g.black_id)?.nick || '?'),
      tag('Result', result), tag('WhiteElo', g.rating_w ?? ''), tag('BlackElo', g.rating_b ?? ''),
      tag('TimeControl', `${Math.round(g.time_ms / 1000)}+${Math.round(g.inc_ms / 1000)}`), tag('Termination', g.status),
    ];
    const body = san.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');
    return { pgn: `${head.join('\n')}\n\n${body}${body ? ' ' : ''}${result}`, san };
  }

  coachPanel() {
    const online = this.onlineIds();
    const stats = new Map();
    for (const m of this.activeMembers()) {
      stats.set(m.id, { id: m.id, nick: m.nick, role: m.role, online: online.has(m.id), account: !!m.account_id, games: 0, wins: 0, draws: 0, losses: 0, last: null });
    }
    for (const g of this.sql.exec("SELECT * FROM games WHERE status NOT IN ('started', 'aborted', 'noStart')").toArray()) {
      for (const [id, color] of [[g.white_id, 'white'], [g.black_id, 'black']]) {
        const s = stats.get(id);
        if (!s) continue;
        s.games++;
        if (!g.winner) s.draws++; else if (g.winner === color) s.wins++; else s.losses++;
        if (!s.last || g.ended_at > s.last) s.last = g.ended_at;
      }
    }
    return {
      members: [...stats.values()].sort((x, y) => y.games - x.games || x.nick.localeCompare(y.nick, 'pl')),
      ongoing: this.runningGames().map((g) => ({
        id: g.id, white: this.member(g.white_id)?.nick || '?', black: this.member(g.black_id)?.nick || '?',
        plies: g.moves.length, speed: g.speed, label: `${g.time_ms / 60000}+${g.inc_ms / 1000}`, rated: !!g.rated,
      })),
      requests: this.requestsList(), blocked: this.blockedList(), invites: this.invitesList(), approve: this.approvalOn(),
    };
  }

  history(memberId) {
    const rows = memberId
      ? this.sql.exec("SELECT * FROM games WHERE status != 'started' AND (white_id = ? OR black_id = ?) ORDER BY ended_at DESC LIMIT 30", memberId, memberId)
      : this.sql.exec("SELECT * FROM games WHERE status != 'started' ORDER BY ended_at DESC LIMIT 30");
    return rows.toArray().map((r) => {
      const g = this.hydrate(r);
      return {
        id: g.id, white: this.member(g.white_id)?.nick || '?', black: this.member(g.black_id)?.nick || '?',
        whiteId: g.white_id, blackId: g.black_id,
        speed: g.speed, rated: !!g.rated, status: g.status, winner: g.winner || null,
        label: `${g.time_ms / 60000}+${g.inc_ms / 1000}`, plies: g.moves.length,
        diffW: g.diff_w, diffB: g.diff_b, unrated: g.x.unrated || null, endedAt: g.ended_at,
      };
    });
  }

  // --- wyzwania ---
  tempo(msg) {
    if (msg.days) fail('Partie korespondencyjne w klubach będą później.');
    const time = Number(msg.time);
    const inc = Number(msg.increment ?? 0);
    if (time < this.L.minTime) fail(this.test ? 'Nieprawidłowy czas partii.' : 'Najkrótsze tempo to 10 minut — żeby był czas na wpisanie ruchu.');
    if (!(time <= 180)) fail('Nieprawidłowy czas partii.');
    if (!(Number.isInteger(inc) && inc >= 0 && inc <= 180)) fail('Nieprawidłowy dodatek czasu.');
    return { time, inc, time_ms: Math.round(time * 60000), inc_ms: inc * 1000 };
  }
  needRatedAccounts(...ids) {
    if (ids.every((id) => this.accountIdOf(id))) return;
    fail(ids.length > 1 ? 'Partia rankingowa wymaga konta u obojga graczy. Zagrajcie towarzysko albo załóżcie konta.'
      : 'Partia rankingowa wymaga konta. Zagraj towarzysko albo załóż konto.');
  }

  async cmdChallenge(me, msg) {
    const to = String(msg.to ?? '');
    if (to === me) fail('Nie możesz wyzwać samego siebie.');
    const target = this.member(to);
    if (!target || target.removed) fail('Nie ma takiego gracza.');
    const { time, inc } = this.tempo(msg);
    const rated = msg.rated ? 1 : 0;
    if (rated) this.needRatedAccounts(me, to);
    if (this.isPublic()) {
      if (this.isBlocked(me, to)) fail('Nie możesz wyzwać tego gracza.');
      if (!this.onlineIds().has(to)) fail('Ten gracz jest teraz poza aplikacją.');
    }
    // obaj wyzwali się nawzajem (np. „Rewanż” u obu) — partia rusza od razu
    const theirs = this.sql.exec('SELECT * FROM challenges WHERE from_id = ? AND to_id = ? AND time_ms = ? AND inc_ms = ? AND rated = ?',
      to, me, Math.round(time * 60000), inc * 1000, rated).toArray()[0];
    if (theirs) {
      const r = await this.cmdAccept(me, theirs.id);
      return { matched: true, gameId: r.gameId };
    }
    const color = ['white', 'black'].includes(msg.color) ? msg.color : 'random';
    for (const o of this.sql.exec('SELECT id FROM challenges WHERE from_id = ? AND to_id = ?', me, to).toArray()) {
      this.sql.exec('DELETE FROM challenges WHERE id = ?', o.id);
      this.toMember(to, { t: 'event', ev: { type: 'challengeGone', id: o.id } });
    }
    const id = randomCode(10);
    const ch = { id, from_id: me, to_id: to, time_ms: Math.round(time * 60000), inc_ms: inc * 1000, color, rated, created_at: Date.now() };
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
  cmdCancel(me, id) { const ch = this.getChallenge(id); if (ch && ch.from_id === me) this.endChallenge(ch, 'canceled'); return {}; }
  cmdDecline(me, id) { const ch = this.getChallenge(id); if (ch && ch.to_id === me) this.endChallenge(ch, 'declined'); return {}; }
  async cmdAccept(me, id) {
    const ch = this.getChallenge(id);
    if (!ch || ch.to_id !== me) fail('To wyzwanie jest już nieaktualne.');
    const challengerWhite = ch.color === 'white' || (ch.color === 'random' && Math.random() < 0.5);
    this.sql.exec('DELETE FROM challenges WHERE id = ?', ch.id);
    this.toMember(ch.to_id, { t: 'event', ev: { type: 'challengeGone', id: ch.id } });
    const g = await this.createGame(challengerWhite ? ch.from_id : ch.to_id, challengerWhite ? ch.to_id : ch.from_id, ch.time_ms, ch.inc_ms, ch.rated);
    this.toMember(ch.from_id, { t: 'challengeResult', id: ch.id, result: 'accepted', gameId: g.id });
    return { gameId: g.id };
  }

  async createGame(white, black, timeMs, incMs, rated) {
    if (rated) await this.refreshRatings();
    const speed = speedOf(timeMs, incMs);
    const sp = ratingSpeed(speed);
    const rw = this.ratingFor(white, sp);
    const rb = this.ratingFor(black, sp);
    let gid;
    do { gid = randomCode(8); } while (this.getGame(gid));
    const now = Date.now();
    this.sql.exec(`INSERT INTO games (id, white_id, black_id, speed, time_ms, inc_ms, rated, status, moves, wtime, btime,
      last_move_at, rating_w, rating_b, prov_w, prov_b, created_at, extra) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', '', ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    gid, white, black, speed, timeMs, incMs, rated ? 1 : 0, timeMs, timeMs, now,
    rw ? Math.round(rw.rating) : null, rb ? Math.round(rb.rating) : null,
    rw && rw.rd > PROVISIONAL_RD ? 1 : 0, rb && rb.rd > PROVISIONAL_RD ? 1 : 0, now);
    const g = this.getGame(gid);
    this.reportStat({ kind: 'game_start' });
    const seeks = this.sql.exec('SELECT id, member_id FROM seeks WHERE member_id IN (?, ?)', white, black).toArray();
    this.sql.exec('DELETE FROM seeks WHERE member_id IN (?, ?)', white, black);
    for (const pid of [white, black]) this.toMember(pid, { t: 'event', ev: { type: 'gameStart', game: this.gameInfo(g, pid) } });
    for (const s of seeks) this.toMember(s.member_id, { t: 'seekResult', id: s.id, result: 'accepted', gameId: gid });
    if (seeks.length) this.broadcastSeeks();
    return g;
  }

  // --- poczekalnia: losowe parowanie (to samo tempo i rodzaj, najbliższy ranking) ---
  async cmdSeek(me, msg) {
    const { time_ms, inc_ms } = this.tempo(msg);
    const rated = msg.rated ? 1 : 0;
    if (rated) this.needRatedAccounts(me);
    this.sql.exec('DELETE FROM seeks WHERE member_id = ?', me);
    const sp = ratingSpeed(speedOf(time_ms, inc_ms));
    const mine = this.ratingFor(me, sp)?.rating ?? DEFAULT.rating;
    const online = this.onlineIds();
    const rOf = (id) => this.ratingFor(id, sp)?.rating ?? DEFAULT.rating;
    const cands = this.sql.exec('SELECT * FROM seeks WHERE time_ms = ? AND inc_ms = ? AND rated = ? AND member_id != ?', time_ms, inc_ms, rated, me)
      .toArray().filter((s) => online.has(s.member_id) && !(this.isPublic() && this.isBlocked(me, s.member_id)));
    if (cands.length) {
      cands.sort((x, y) => Math.abs(rOf(x.member_id) - mine) - Math.abs(rOf(y.member_id) - mine) || x.created_at - y.created_at);
      const opp = cands[0];
      const meWhite = Math.random() < 0.5;
      const g = await this.createGame(meWhite ? me : opp.member_id, meWhite ? opp.member_id : me, time_ms, inc_ms, rated);
      return { matched: true, gameId: g.id };
    }
    const id = randomCode(10);
    this.sql.exec('INSERT INTO seeks (id, member_id, time_ms, inc_ms, rated, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, me, time_ms, inc_ms, rated, Date.now());
    this.broadcastSeeks();
    return { id };
  }
  cmdSeekCancel(me, id) {
    if (this.sql.exec('SELECT 1 FROM seeks WHERE id = ? AND member_id = ?', String(id ?? ''), me).toArray().length) {
      this.sql.exec('DELETE FROM seeks WHERE id = ?', String(id));
      this.broadcastSeeks();
    }
    return {};
  }
  async cmdSeekAccept(me, id) {
    const s = this.sql.exec('SELECT * FROM seeks WHERE id = ?', String(id ?? '')).toArray()[0];
    if (!s || !this.onlineIds().has(s.member_id)) fail('Ten gracz już nie szuka rywala.');
    if (s.member_id === me) fail('To Twoje szukanie.');
    if (s.rated) this.needRatedAccounts(me);
    const meWhite = Math.random() < 0.5;
    const g = await this.createGame(meWhite ? me : s.member_id, meWhite ? s.member_id : me, s.time_ms, s.inc_ms, s.rated);
    return { gameId: g.id };
  }

  // --- partia ---
  myGame(me, id) {
    const g = this.getGame(String(id ?? ''));
    if (!g) fail('Nie znaleziono partii.');
    const color = this.colorOf(g, me);
    if (!color) fail('To nie Twoja partia.');
    return { g, color };
  }
  viewableGame(me, id) {
    const g = this.getGame(String(id ?? ''));
    if (!g) fail('Nie znaleziono partii.');
    const color = this.colorOf(g, me);
    if (!color && !this.isCoach(me)) fail('To nie Twoja partia.');
    return { g, color };
  }
  cmdWatch(ws, a, gameId) {
    const { g, color } = this.viewableGame(a.memberId, gameId);
    ws.serializeAttachment({ ...a, watch: [...new Set([...(a.watch || []), g.id])].slice(-5) });
    const now = Date.now();
    if (g.status === 'started') this.checkClock(g, now);
    this.send(ws, { t: 'game', id: g.id, msg: { ...this.fullOf(g), myColor: color, spectator: !color } });
    if (g.status === 'started' && color) {
      const gone = this.goneInfo(g, color === 'white' ? g.black_id : g.white_id, now);
      if (gone) this.send(ws, { t: 'game', id: g.id, msg: gone });
    }
    return {};
  }

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
    if (!hasMatingMaterial(this.chessFor(g), winner[0])) this.finish(g, 'outoftime', null, now, true);
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
    if (piece && piece.type === 'k' && target && target.type === 'r' && target.color === piece.color) to = (to[0] > from[0] ? 'g' : 'c') + from[1];
    let mv = null;
    try { mv = chess.move({ from, to, promotion: uci[4] }); } catch { mv = null; }
    if (!mv) fail('Ruch niedozwolony.');
    uci = mv.from + mv.to + (mv.promotion || '');
    if (g.moves.length >= 2) {
      const el = now - g.last_move_at;
      if (color === 'white') g.wtime = g.wtime - el + g.inc_ms; else g.btime = g.btime - el + g.inc_ms;
    }
    g.last_move_at = now;
    g.moves.push(uci);
    g.wdraw = 0; g.bdraw = 0; g.wtakeback = 0; g.btakeback = 0;
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
      g[theirs] = 0; g[mine] = 0;
    }
    this.saveGame(g);
    this.broadcastState(g);
    return {};
  }
  // Cofnięcie ruchu za zgodą rywala. Proszący cofa swój ostatni ruch (jeśli rywal odpowiedział — oba).
  // Limit: po odmowie można poprosić jeszcze raz o ten sam ruch, dopóki gracz nie usłyszał 2 odmów; potem raz na ruch.
  cmdTakeback(me, id, yes) {
    const { g, color } = this.running(me, id);
    const mine = color === 'white' ? 'wtakeback' : 'btakeback';
    const theirs = color === 'white' ? 'btakeback' : 'wtakeback';
    g.x.tb ||= {};
    if (!yes) {
      if (g[theirs]) { // odmowa — liczy się proszącemu
        const asker = other(color);
        g.x.tb[asker] = { ...(g.x.tb[asker] || { ref: 0, ply: -1, n: 0 }) };
        g.x.tb[asker].ref++;
      }
      g[theirs] = 0; g[mine] = 0;
    } else if (g[theirs]) {
      const asker = other(color);
      const plies = this.turnOf(g) === asker ? 2 : 1;
      if (g.moves.length < plies) fail('Nie ma czego cofnąć.');
      g.moves.splice(g.moves.length - plies, plies);
      g.wtakeback = 0; g.btakeback = 0; g.wdraw = 0; g.bdraw = 0;
      g.last_move_at = Date.now();
      this.chessCache.delete(g.id);
    } else {
      const myMoves = color === 'white' ? Math.ceil(g.moves.length / 2) : Math.floor(g.moves.length / 2);
      if (myMoves < 1) fail('Nie zagrałeś jeszcze żadnego ruchu.');
      if (this.takebackLeft(g, color) < 1) fail('O cofnięcie tego ruchu już prosiłeś. Gra toczy się dalej.');
      const t = g.x.tb[color] || { ref: 0, ply: -1, n: 0 };
      g.x.tb[color] = t.ply === g.moves.length ? { ...t, n: t.n + 1 } : { ...t, ply: g.moves.length, n: 1 };
      g[mine] = 1;
    }
    this.saveGame(g);
    this.broadcastState(g);
    return {};
  }
  cmdResign(me, id) { const { g, color } = this.running(me, id); this.finish(g, 'resign', other(color), Date.now()); return {}; }
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
    if (this.onlineIds().has(opp.id) || !opp.offline_since || now < opp.offline_since + this.L.gone + this.L.claim) fail('Rywal jest jeszcze w partii.');
    this.finish(g, victory ? 'timeout' : 'draw', victory ? color : null, now);
    return {};
  }

  // Koniec partii: zapis, rozesłanie stanu, potem (w tle) wspólny ranking.
  finish(g, status, winner, now, clockSettled = false) {
    if (!clockSettled && g.moves.length >= 2) {
      const el = now - g.last_move_at;
      if (this.turnOf(g) === 'white') g.wtime = Math.max(0, g.wtime - el); else g.btime = Math.max(0, g.btime - el);
      g.last_move_at = now;
    }
    g.status = status;
    g.winner = winner;
    g.ended_at = now;
    g.wdraw = 0; g.bdraw = 0; g.wtakeback = 0; g.btakeback = 0;
    this.reportStat(ENDED_UNRATED.has(status) ? { kind: 'game_aborted' }
      : { kind: 'game', room: this.kv('room_id'), roomName: this.kv('name'), players: [g.white_id, g.black_id] });
    let rate = null;
    if (g.rated) {
      if (ENDED_UNRATED.has(status)) g.x.unrated = 'aborted';
      else if (SHORT_UNRATED.has(status) && g.moves.length < SHORT_PLIES) g.x.unrated = 'short';
      else if (!this.accountIdOf(g.white_id) || !this.accountIdOf(g.black_id)) g.x.unrated = 'account';
      else rate = { white: this.accountIdOf(g.white_id), black: this.accountIdOf(g.black_id), speed: ratingSpeed(g.speed), score: winner === 'white' ? 1 : winner === 'black' ? 0 : 0.5 };
    }
    this.saveGame(g);
    this.chessCache.delete(g.id);
    this.broadcastState(g);
    for (const pid of [g.white_id, g.black_id]) this.toMember(pid, { t: 'event', ev: { type: 'gameFinish', game: this.gameInfo(g, pid) } });
    if (rate) {
      const apply = (res) => this.applyRating(g.id, res);
      if (this.isPublic()) apply(this.acctRate(rate));
      else this.ctx.waitUntil?.(this.callPublic('acct-rate', rate).then(apply).catch((e) => console.error('rate', e)));
    } else if (g.rated) {
      this.sendRatingResult(g);
    }
  }
  applyRating(gameId, res) {
    const g = this.getGame(gameId);
    if (!g) return;
    if (res?.counted) {
      g.diff_w = res.diffW; g.diff_b = res.diffB;
      if (!this.isPublic()) this.storeRatings(res.ratings);
    } else {
      g.x.unrated = res?.reason || 'error';
    }
    this.saveGame(g);
    this.sendRatingResult(g);
    for (const pid of [g.white_id, g.black_id]) this.toMember(pid, { t: 'me', ratings: this.ratingsView(pid) });
    this.broadcastMembers();
  }
  sendRatingResult(g) {
    const result = { counted: !g.x.unrated, reason: g.x.unrated || null, diffW: g.diff_w, diffB: g.diff_b };
    this.toWatchers(g, { type: 'rating', result });
  }

  // --- wyjście rywala ---
  goneInfo(g, oppId, now) {
    if (this.onlineIds().has(oppId)) return null;
    const m = this.member(oppId);
    if (!m || !m.offline_since) return null;
    const t1 = m.offline_since + this.L.gone;
    const t2 = t1 + this.L.claim;
    if (now < t1) return null;
    return { type: 'opponentGone', gone: true, claimWinInSeconds: now >= t2 ? 0 : Math.ceil((t2 - now) / 1000) };
  }

  // --- alarm: zegary, wygasanie wyzwań, wyjście rywala, martwe połączenia ---
  async alarm() {
    const now = Date.now();
    this.sweepSockets(now);
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
    for (const ch of this.sql.exec('SELECT * FROM challenges WHERE created_at <= ?', now - this.L.challenge).toArray()) this.endChallenge(ch, 'canceled');
    this.reschedule();
  }
  sweepSockets(now) {
    for (const ws of this.openSockets()) {
      const a = this.att(ws);
      const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = Math.max(a.at || 0, pong ? pong.getTime() : 0);
      if (now - last > (a.memberId ? this.L.stale : this.L.hello)) {
        try { ws.close(4000, 'timeout'); } catch {}
        this.onSocketGone(ws);
      }
    }
  }
  reschedule() {
    const now = Date.now();
    const times = [];
    const L = this.L;
    const offline = new Map(this.sql.exec('SELECT id, offline_since FROM members WHERE offline_since IS NOT NULL').toArray().map((m) => [m.id, m.offline_since]));
    const running = this.runningGames();
    for (const g of running) {
      times.push(g.moves.length < 2 ? g.last_move_at + L.noStart : g.last_move_at + (this.turnOf(g) === 'white' ? g.wtime : g.btime));
      for (const pid of [g.white_id, g.black_id]) {
        const since = offline.get(pid);
        if (!since) continue;
        const t1 = since + L.gone;
        const t2 = t1 + L.claim;
        if (now < t1) times.push(t1); else if (now < t2) times.push(t2);
      }
    }
    const ch = this.sql.exec('SELECT MIN(created_at) AS t FROM challenges').one().t;
    if (ch != null) times.push(ch + L.challenge);
    const sockets = this.openSockets();
    const seeking = this.sql.exec('SELECT 1 FROM seeks LIMIT 1').toArray().length;
    if (sockets.length && (running.length || seeking || sockets.some((ws) => !this.att(ws).memberId))) times.push(now + L.sweep);
    if (!times.length) { this.ctx.storage.deleteAlarm(); return; }
    this.ctx.storage.setAlarm(Math.max(now + 50, Math.min(...times)));
  }
}

Object.assign(Room.prototype, accountMethods, statsMethods, clubMethods, socialMethods, memberMethods);

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

// Testy serwera na lokalnym `wrangler dev` (TEST_MODE=1 z .dev.vars: krótkie limity i blokady).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, Client, sleep } from './helpers.mjs';
import { rateGame, DEFAULT } from '../src/glicko.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

const uniq = () => Math.random().toString(36).slice(2, 7);
const dev = () => 'dev-' + uniq() + uniq();
const KEY = { Authorization: 'Bearer klucz-testowy-statystyk' };

async function register(prefix = 'G') {
  const nick = prefix + uniq();
  const password = 'haslo-testowe-' + uniq();
  const r = await api(srv.base, 'POST', '/api/account/register', { nick, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { nick, id: r.data.memberId, token: r.data.token, password };
}
// Klub zakłada konto; domyślnie z wyłączonym zatwierdzaniem (szybkie dołączanie w testach).
async function createClub(name, nick, owner, { approve = false } = {}) {
  const acc = owner || await register('Own');
  const r = await api(srv.base, 'POST', '/api/rooms', { name, nick, accountToken: acc.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (!approve) {
    const O = await connect(r.data.room, r.data.token);
    assert.ok((await O.req('setApproval', { on: false })).ok);
    O.close();
  }
  return { ...r.data, owner: acc };
}
// Dołączenie kontem (nowym, jeśli nie podano).
async function joinClub(code, opts = {}) {
  const acc = opts.account || await register('J');
  const r = await api(srv.base, 'POST', '/api/rooms/join', { code, nick: opts.nick, password: opts.password, accountToken: acc.token });
  return { ...r, account: acc };
}
async function connect(room, token) { const c = new Client(srv.base, room, token); await c.connect(); return c; }

async function clubWithTwo() {
  const a = await register('A');
  const b = await register('B');
  const club = await createClub('Klub ' + uniq(), undefined, a);
  const j = await joinClub(club.code, { account: b });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  const A = await connect(club.room, club.token);
  const B = await connect(club.room, j.data.token);
  return { club, a, b, A, B, aId: club.memberId, bId: j.data.memberId };
}
async function startGame(ctx, { time = 10, increment = 5, rated = false, color = 'white' } = {}) {
  const { A, B, bId } = ctx;
  const ch = await A.req('challenge', { to: bId, time, increment, rated, color });
  assert.ok(ch.ok, ch.error);
  await B.wait((m) => m.t === 'event' && m.ev.type === 'challenge' && m.ev.challenge.id === ch.id);
  const acc = await B.req('accept', { id: ch.id });
  assert.ok(acc.ok, acc.error);
  const gameId = acc.gameId;
  await A.req('watch', { gameId }); await B.req('watch', { gameId });
  return { gameId, W: A, Bl: B };
}
// 10 półruchów (żeby poddanie liczyło się do rankingu)
const OPENING = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'f8c5', 'e1g1', 'd7d6'];
async function playMoves(gameId, W, Bl, moves, from = 0) {
  for (let i = 0; i < moves.length; i++) {
    const r = await ((from + i) % 2 === 0 ? W : Bl).req('move', { gameId, uci: moves[i], ply: from + i });
    assert.ok(r.ok, `${moves[i]}: ${r.error}`);
  }
}
const gm = (C, gameId, type, mark, ms) => C.gameMsg(gameId, type, mark, ms);

test('Glicko-2: start 1200, wygrana podnosi', () => {
  assert.equal(DEFAULT.rating, 1200);
  const r = rateGame({ ...DEFAULT }, { ...DEFAULT }, 1);
  assert.ok(r.white.rating > 1300 && r.black.rating < 1100);
});

test('klub: tylko z kontem; kod NAZWA-XXXXX, sprawdzenie, własny nick, zajęty nick, kod bez myślnika', async () => {
  assert.match((await api(srv.base, 'POST', '/api/rooms', { name: 'Bez konta', nick: 'Ala' })).data.error, /z kontem/);
  const c = await createClub('Klub Hetman — środy', 'Trener');
  assert.match(c.code, /^KLUBH-[A-Z0-9]{5}$/);
  assert.match((await api(srv.base, 'POST', '/api/rooms/join', { code: c.code, nick: 'Anon', deviceId: dev() })).data.error, /z kontem/);
  const look = await api(srv.base, 'POST', '/api/rooms/lookup', { code: c.code.toLowerCase(), accountToken: c.owner.token });
  assert.deepEqual(look.data, { code: c.code, name: 'Klub Hetman — środy', needsPassword: false });
  const j = await joinClub(c.code.replace('-', ''), { nick: 'Kasia' });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  assert.equal(j.data.room, c.room);
  const dup = await joinClub(c.code, { nick: 'kasia' });
  assert.match(dup.data.error, /zajęty/);
  const T = await connect(c.room, c.token);
  assert.equal(T.welcome.room.code, c.code);
  assert.equal(T.welcome.room.canManage, true);
  assert.equal(T.welcome.members.length, 2);
  T.close();
});

test('blokada za złe kody: rośnie (test: 3 → 3 s, potem 2 → 3 s), dotyczy konta, nie innych', async () => {
  const c = await createClub('Blokady', 'Ola');
  const acc = await register('L');
  const bad = () => api(srv.base, 'POST', '/api/rooms/join', { code: 'BLOKA-ZZZZZ', nick: 'X' + uniq(), accountToken: acc.token });
  let r = await bad(); assert.match(r.data.error, /Pozostało prób: 2/);
  await bad();
  r = await bad(); assert.match(r.data.error, /zablokowane/);
  r = await api(srv.base, 'POST', '/api/rooms/join', { code: c.code, accountToken: acc.token });
  assert.match(r.data.error, /zablokowane do/);
  const other = await register('M');
  r = await api(srv.base, 'POST', '/api/rooms/join', { code: c.code, accountToken: other.token });
  assert.equal(r.status, 200);
  await sleep(3200);
  await bad();
  r = await bad(); assert.match(r.data.error, /zablokowane/);
  await sleep(3200);
  r = await api(srv.base, 'POST', '/api/rooms/join', { code: c.code, accountToken: acc.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('hasło klubu, zmiana kodu, administrator, usuwanie członków i wyjście', async () => {
  const owner = await register('O');
  const c = await createClub('Szachy Plus', undefined, owner);
  const O = await connect(c.room, c.token);
  let r = await O.req('setRoomPassword', { password: 'wieza8' });
  assert.ok(r.ok && r.hasPassword, r.error);
  assert.equal((await api(srv.base, 'POST', '/api/rooms/lookup', { code: c.code, accountToken: owner.token })).data.needsPassword, true);
  assert.match((await joinClub(c.code, { nick: 'Bez' })).data.error, /hasło jest złe/);
  const p1 = await register('P');
  const j1 = await joinClub(c.code, { account: p1, password: 'wieza8' });
  assert.equal(j1.status, 200, JSON.stringify(j1.data));
  const j2 = await joinClub(c.code, { nick: 'Zosia', password: 'wieza8' });
  const P1 = await connect(c.room, j1.data.token);
  const Z = await connect(c.room, j2.data.token);

  const nc = await O.req('changeCode');
  assert.ok(nc.ok && nc.code !== c.code, nc.error);
  assert.match((await joinClub(c.code, { nick: 'Nowy', password: 'wieza8' })).data.error, /Nie ma klubu/);
  assert.equal((await joinClub(nc.code, { nick: 'Nowy', password: 'wieza8' })).status, 200);

  assert.equal((await P1.req('removeMember', { id: j2.data.memberId })).ok, false);
  assert.ok((await O.req('setRole', { id: j1.data.memberId, role: 'admin' })).ok);
  await P1.wait((m) => m.t === 'roomInfo' && m.room.canManage);
  assert.equal((await P1.req('removeMember', { id: c.memberId })).ok, false);
  r = await P1.req('removeMember', { id: j2.data.memberId });
  assert.ok(r.ok, r.error);
  await Z.wait((m) => m.t === 'removed');
  assert.equal((await new Client(srv.base, c.room, j2.data.token).connect()).t, 'authFailed');

  assert.ok((await O.req('setRole', { id: j1.data.memberId, role: 'member' })).ok);
  assert.ok((await O.req('removeMember', { id: j1.data.memberId })).ok);
  assert.match((await joinClub(nc.code, { account: p1, password: 'wieza8' })).data.error, /usunięty/);
  const p2 = await register('Q');
  const j3 = await joinClub(nc.code, { account: p2, password: 'wieza8' });
  const Q = await connect(c.room, j3.data.token);
  assert.ok((await Q.req('leaveRoom')).ok);
  assert.equal((await joinClub(nc.code, { account: p2, password: 'wieza8' })).status, 200);
  O.close();
});

test('zatwierdzanie członków: prośba, odrzucenia (2 → blokada), odblokowanie, zatwierdzenie, zaproszenie po nicku', async () => {
  const c = await createClub('Klub zatwierdzany', undefined, undefined, { approve: true });
  const O = await connect(c.room, c.token);
  assert.equal(O.welcome.room.approve, true);
  assert.equal(O.welcome.room.requests, 0);
  const p = await register('Pr');
  const P = await connect('publiczny', p.token);
  const enter = () => api(srv.base, 'POST', `/api/rooms/${c.room}/account-login`, { accountToken: p.token });

  // prośba: „oczekuje” w Moich klubach, założyciel widzi licznik
  let mark = O.mark();
  let j = await joinClub(c.code, { account: p, nick: 'Prosi' });
  assert.equal(j.data.pending, true, JSON.stringify(j.data));
  assert.equal((await O.wait((m) => m.t === 'roomInfo' && m.room.requests === 1, 5000, mark)).room.requests, 1);
  assert.equal((await P.req('myRooms')).rooms.find((r) => r.room === c.room).status, 'pending');
  const e1 = await enter();
  assert.equal(e1.status, 409); assert.equal(e1.data.pending, true);
  assert.equal((await O.req('coachPanel')).requests[0].nick, 'Prosi');

  // dwa odrzucenia → kolejna prośba zablokowana, osoba na liście zablokowanych
  for (let i = 0; i < 2; i++) {
    mark = P.mark();
    assert.ok((await O.req('rejectRequest', { id: p.id })).ok);
    await P.wait((m) => m.t === 'event' && m.ev.type === 'clubStatus' && m.ev.event === 'rejected', 5000, mark);
    if (i === 0) assert.equal((await joinClub(c.code, { account: p })).data.pending, true);
  }
  assert.equal((await P.req('myRooms')).rooms.some((r) => r.room === c.room), false);
  assert.match((await joinClub(c.code, { account: p })).data.error, /odrzucone/);
  let panel = await O.req('coachPanel');
  assert.deepEqual(panel.blocked.map((b) => [b.nick, b.reason]), [[p.nick, 'rejected']]); // druga prośba była z nickiem konta

  // odblokowanie → nowa prośba → zatwierdzenie
  assert.ok((await O.req('unblockMember', { id: p.id })).ok);
  assert.equal((await joinClub(c.code, { account: p, nick: 'Prosi' })).data.pending, true);
  mark = P.mark();
  assert.ok((await O.req('approveRequest', { id: p.id })).ok);
  await P.wait((m) => m.t === 'event' && m.ev.type === 'clubStatus' && m.ev.event === 'approved', 5000, mark);
  assert.equal((await P.req('myRooms')).rooms.find((r) => r.room === c.room).status, 'member');
  const e2 = await enter();
  assert.equal(e2.status, 200, JSON.stringify(e2.data));
  assert.equal(e2.data.nick, 'Prosi');

  // zaproszenie po nicku: wejście jednym kliknięciem, bez kodu; zdejmuje blokadę po usunięciu
  const q = await register('Zap');
  const Q = await connect('publiczny', q.token);
  assert.match((await O.req('inviteNick', { nick: 'nie-ma-' + uniq() })).error, /Nie ma konta/);
  mark = Q.mark();
  assert.ok((await O.req('inviteNick', { nick: q.nick.toLowerCase() })).ok);
  await Q.wait((m) => m.t === 'event' && m.ev.type === 'clubStatus' && m.ev.event === 'invited', 5000, mark);
  assert.equal((await Q.req('myRooms')).rooms.find((r) => r.room === c.room).status, 'invited');
  let eq = await api(srv.base, 'POST', `/api/rooms/${c.room}/account-login`, { accountToken: q.token });
  assert.equal(eq.status, 200, JSON.stringify(eq.data));
  assert.equal(eq.data.nick, q.nick);
  assert.ok((await O.req('removeMember', { id: eq.data.memberId })).ok);
  panel = await O.req('coachPanel');
  assert.ok(panel.blocked.some((b) => b.id === q.id && b.reason === 'removed'));
  assert.match((await joinClub(c.code, { account: q })).data.error, /usunięty/);
  assert.ok((await O.req('inviteNick', { nick: q.nick })).ok);
  eq = await api(srv.base, 'POST', `/api/rooms/${c.room}/account-login`, { accountToken: q.token });
  assert.equal(eq.status, 200, JSON.stringify(eq.data));

  // ustawienie zmienia tylko założyciel; po wyłączeniu wejście od razu
  const M = await connect(c.room, e2.data.token);
  assert.ok((await O.req('setRole', { id: e2.data.memberId, role: 'admin' })).ok);
  assert.match((await M.req('setApproval', { on: false })).error, /założyciel/);
  assert.ok((await O.req('setApproval', { on: false })).ok);
  assert.ok((await joinClub(c.code)).data.token);
  for (const x of [O, P, Q, M]) x.close();
});

test('partia 10+5: ruch nielegalny, zegar, roszada; rankingowa liczy się do wspólnego rankingu', async () => {
  const ctx = await clubWithTwo();
  const { gameId, W, Bl } = await startGame(ctx, { rated: true });
  const full = await gm(W, gameId, 'full');
  assert.equal(full.white.rating, 1200);
  let r = await Bl.req('move', { gameId, uci: 'e7e5', ply: 0 });
  assert.match(r.error, /nie Twój/);
  r = await W.req('move', { gameId, uci: 'e2e5', ply: 0 });
  assert.match(r.error, /niedozwolony/);
  await playMoves(gameId, W, Bl, OPENING.slice(0, 2));
  await sleep(1200);
  let mark = Bl.mark();
  await W.req('move', { gameId, uci: 'g1f3', ply: 2 });
  const st = await gm(Bl, gameId, 'state', mark);
  const spent = 600000 + 5000 - st.state.wtime;
  assert.ok(spent >= 1100 && spent < 2500, `zużyto ${spent}`);
  await playMoves(gameId, W, Bl, OPENING.slice(3, 8), 3);
  mark = Bl.mark();
  r = await W.req('move', { gameId, uci: 'e1h1', ply: 8 });
  assert.ok(r.ok, r.error);
  assert.equal((await gm(Bl, gameId, 'state', mark)).state.moves[8], 'e1g1');
  await Bl.req('move', { gameId, uci: 'd7d6', ply: 9 });
  mark = W.mark();
  await Bl.req('resign', { gameId });
  const rating = await W.wait((m) => m.t === 'game' && m.msg.type === 'rating', 5000, mark);
  assert.equal(rating.msg.result.counted, true);
  assert.ok(rating.msg.result.diffW > 0 && rating.msg.result.diffB < 0);
  const me = await W.wait((m) => m.t === 'me', 3000, mark);
  assert.ok(me.ratings.rapid.rating > 1200);
  const P = await connect('publiczny', ctx.a.token);
  assert.ok(P.welcome.me.ratings.rapid.rating > 1200);
  assert.equal(P.welcome.me.ratings.rapid.games, 1);
  for (const x of [W, Bl, P]) x.close();
});

test('ranking: krótkie poddanie się nie liczy; limit 3 dziennie z tym samym rywalem', async () => {
  const ctx = await clubWithTwo();
  let g = await startGame(ctx, { rated: true });
  await playMoves(g.gameId, g.W, g.Bl, OPENING.slice(0, 4));
  let mark = g.W.mark();
  await g.Bl.req('resign', { gameId: g.gameId });
  let res = await g.W.wait((m) => m.t === 'game' && m.msg.type === 'rating', 5000, mark);
  assert.deepEqual([res.msg.result.counted, res.msg.result.reason], [false, 'short']);
  for (let i = 0; i < 4; i++) {
    g = await startGame(ctx, { rated: true, time: 10, increment: 0 });
    await playMoves(g.gameId, g.W, g.Bl, OPENING);
    mark = g.W.mark();
    await g.Bl.req('resign', { gameId: g.gameId });
    res = await g.W.wait((m) => m.t === 'game' && m.msg.type === 'rating', 5000, mark);
    if (i < 3) assert.equal(res.msg.result.counted, true, `partia ${i + 1}`);
    else assert.deepEqual([res.msg.result.counted, res.msg.result.reason], [false, 'limit']);
  }
  ctx.A.close(); ctx.B.close();
});

test('ponowne połączenie, koniec czasu z alarmu, wyjście rywala z odliczaniem', async () => {
  const ctx = await clubWithTwo();
  const { gameId, W, Bl } = await startGame(ctx);
  await playMoves(gameId, W, Bl, ['d2d4', 'd7d5', 'c2c4']);
  Bl.close();
  await sleep(3000);
  const tok = (await joinClub(ctx.club.code, { account: ctx.b })).data.token;
  const back = await connect(ctx.club.room, tok);
  await back.req('watch', { gameId });
  const lost = 600000 - (await gm(back, gameId, 'full')).state.btime;
  assert.ok(lost >= 2900 && lost < 4500, `czarne straciły ${lost}`);
  back.close();
  const og = await W.wait((m) => m.t === 'game' && m.msg.type === 'opponentGone' && m.msg.gone, 12000);
  assert.ok(og.msg.claimWinInSeconds > 0);
  await W.wait((m) => m.t === 'game' && m.msg.type === 'opponentGone' && m.msg.claimWinInSeconds === 0, 8000);
  assert.ok((await W.req('claimDraw', { gameId })).ok);
  W.close();
  const c2 = await clubWithTwo();
  const g2 = await startGame(c2, { time: 0.05, increment: 0 });
  await playMoves(g2.gameId, g2.W, g2.Bl, ['e2e4', 'e7e5']);
  const st = await g2.W.wait((m) => m.t === 'game' && m.msg.type === 'state' && m.msg.state.status === 'outoftime', 8000);
  assert.equal(st.msg.state.winner, 'black');
  c2.A.close(); c2.B.close();
});

test('cofnięcie ruchu: zgoda, odmowa; limity próśb (2 na ruch do 2 odmów, potem 1)', async () => {
  const ctx = await clubWithTwo();
  const { gameId, W, Bl } = await startGame(ctx);
  assert.equal((await W.req('takeback', { gameId, yes: true })).ok, false);
  await playMoves(gameId, W, Bl, ['e2e4', 'e7e5', 'g1f3']);
  const ask = () => W.req('takeback', { gameId, yes: true });
  const no = () => Bl.req('takeback', { gameId, yes: false });
  assert.ok((await ask()).ok); assert.ok((await no()).ok);
  assert.ok((await ask()).ok); assert.ok((await no()).ok);
  assert.match((await ask()).error, /już prosiłeś/);
  let mark = Bl.mark();
  await Bl.req('move', { gameId, uci: 'b8c6', ply: 3 });
  const st = await gm(Bl, gameId, 'state', mark);
  assert.equal(st.state.takebackLeft.white, 1);
  await W.req('move', { gameId, uci: 'b1c3', ply: 4 });
  assert.ok((await ask()).ok);
  mark = W.mark();
  assert.ok((await Bl.req('takeback', { gameId, yes: true })).ok);
  assert.deepEqual((await gm(W, gameId, 'state', mark)).state.moves, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  W.close(); Bl.close();
});

test('wzajemne wyzwanie (rewanż u obu) od razu startuje partię', async () => {
  const ctx = await clubWithTwo();
  assert.ok((await ctx.A.req('challenge', { to: ctx.bId, time: 10, increment: 0, color: 'white' })).id);
  const b = await ctx.B.req('challenge', { to: ctx.aId, time: 10, increment: 0, color: 'black' });
  assert.ok(b.matched && b.gameId, JSON.stringify(b));
  ctx.A.close(); ctx.B.close();
});

test('poczekalnia: tylko z kontem, parowanie tego samego tempa, szukanie znika po rozłączeniu', async () => {
  assert.match((await api(srv.base, 'POST', '/api/rooms/join', { code: 'publiczny', deviceId: dev() })).data.error, /z kontem/);
  const [p, q, r] = [await register('P'), await register('Q'), await register('R')];
  const P = await connect('publiczny', p.token), Q = await connect('publiczny', q.token), R = await connect('publiczny', r.token);
  const sp = await P.req('seek', { time: 10, increment: 5, rated: true });
  const sr = await R.req('seek', { time: 15, increment: 10, rated: true });
  assert.ok(sp.id && sr.id);
  const sq = await Q.req('seek', { time: 10, increment: 5, rated: true });
  assert.ok(sq.matched, JSON.stringify(sq));
  await P.wait((m) => m.t === 'seekResult' && m.id === sp.id);
  const mark = Q.mark();
  R.close();
  await Q.wait((m) => m.t === 'seeks' && !m.seeks.some((s) => s.id === sr.id), 12000, mark);
  P.close(); Q.close();
});

test('znajomi: zaproszenie i akceptacja, obecność, odrzucenie po cichu, blokada', async () => {
  const [a, b, c] = [await register('Fa'), await register('Fb'), await register('Fc')];
  const A = await connect('publiczny', a.token), B = await connect('publiczny', b.token), C = await connect('publiczny', c.token);
  assert.match((await A.req('friendInvite', { nick: 'nie-ma-' + uniq() })).error, /Nie ma gracza/);
  assert.ok((await A.req('friendInvite', { nick: b.nick.toLowerCase() })).ok);
  await B.wait((m) => m.t === 'event' && m.ev.type === 'friendInvite');
  assert.equal((await B.req('social')).social.incoming[0].nick, a.nick);
  const s = await B.req('friendAccept', { id: a.id });
  assert.equal(s.social.friends[0].nick, a.nick);
  assert.equal(s.social.friends[0].online, true);
  const mark = A.mark();
  B.close();
  assert.equal((await A.wait((m) => m.t === 'presence' && m.id === b.id, 15000, mark)).online, false);
  await C.req('friendInvite', { id: a.id });
  await A.req('friendDecline', { id: c.id });
  assert.equal((await C.req('social')).social.outgoing.length, 0);
  await A.req('block', { id: c.id });
  assert.match((await C.req('challenge', { to: a.id, time: 10, increment: 0 })).error, /Nie możesz/);
  assert.ok((await C.req('friendInvite', { id: a.id })).ok);
  assert.equal((await A.req('social')).social.incoming.length, 0);
  assert.match((await A.req('challenge', { to: c.id, time: 10, increment: 0 })).error, /Nie możesz/);
  A.close(); C.close();
});

test('konto: popularne hasła, obce litery, zmiana hasła wylogowuje inne urządzenia, blokada sieci, reset', async () => {
  const nick = 'K' + uniq();
  assert.match((await api(srv.base, 'POST', '/api/account/register', { nick, password: 'qwerty123' })).data.error, /popularne/);
  assert.equal((await api(srv.base, 'POST', '/api/account/register', { nick: 'Аnia' + uniq(), password: 'dobre-haslo-77' })).status, 400);
  const reg = await api(srv.base, 'POST', '/api/account/register', { nick, password: 'pierwsze-haslo', email: nick + '@example.com' });
  const other = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'pierwsze-haslo' });
  const P = await connect('publiczny', reg.data.token);
  assert.ok((await P.req('setPassword', { password: 'drugie-haslo-x', oldPassword: 'pierwsze-haslo' })).ok);
  assert.equal((await new Client(srv.base, 'publiczny', other.data.token).connect()).t, 'authFailed');
  const bad = { 'X-Test-IP': 'zgad-' + uniq() };
  for (let i = 0; i < 3; i++) await api(srv.base, 'POST', '/api/account/login', { nick, password: 'zle-zle' }, bad);
  assert.match((await api(srv.base, 'POST', '/api/account/login', { nick, password: 'drugie-haslo-x' }, bad)).data.error, /Za dużo/);
  assert.equal((await api(srv.base, 'POST', '/api/account/login', { nick, password: 'drugie-haslo-x' }, { 'X-Test-IP': 'moje-' + uniq() })).status, 200);
  const rq = await api(srv.base, 'POST', '/api/account/reset-request', { login: nick + '@EXAMPLE.com' });
  assert.equal((await api(srv.base, 'POST', '/api/account/reset', { token: rq.data.debugToken, password: 'trzecie-haslo-9' })).status, 200);
  P.close();
});

test('Moje kluby przy koncie; logowanie komputera telefonem (QR i krótki kod); wyloguj wszystkie urządzenia', async () => {
  const a = await register('Mk');
  const c = await createClub('Klub konta', undefined, a);
  const P = await connect('publiczny', a.token);
  assert.deepEqual(P.welcome.me.rooms.map((x) => x.room), [c.room]);
  assert.equal(P.welcome.me.passkeys, 0);
  assert.equal((await api(srv.base, 'POST', `/api/rooms/${c.room}/account-login`, { accountToken: a.token })).data.memberId, c.memberId);
  assert.equal((await api(srv.base, 'POST', '/api/rooms/transfer-code', { code: '123456' })).status, 404); // przeniesienia już nie ma

  // komputer: kod QR; telefon: podgląd urządzenia i zatwierdzenie; komputer dostaje konto jeden raz
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' };
  const q = (await api(srv.base, 'POST', '/api/account/qr-start', { ua: UA['User-Agent'] })).data;
  assert.match(q.short, /^[A-Z0-9]{6}$/);
  assert.equal((await api(srv.base, 'POST', '/api/account/qr-poll', { id: q.id, secret: q.secret })).data.status, 'waiting');
  assert.equal((await api(srv.base, 'POST', '/api/account/qr-poll', { id: q.id, secret: 'zly' })).data.status, 'expired');
  assert.match((await P.req('qrInfo', { code: 'ZZZZZZ' })).error, /zły albo wygasł/);
  assert.equal((await P.req('qrInfo', { code: q.id })).device, 'Windows · Chrome');
  assert.ok((await P.req('qrApprove', { code: q.short.toLowerCase() })).ok);
  const done = (await api(srv.base, 'POST', '/api/account/qr-poll', { id: q.id, secret: q.secret })).data;
  assert.equal(done.status, 'approved');
  assert.equal(done.nick, a.nick);
  assert.deepEqual(done.rooms.map((x) => x.room), [c.room]);
  assert.equal((await api(srv.base, 'POST', '/api/account/qr-poll', { id: q.id, secret: q.secret })).data.status, 'expired');
  const PC = await connect('publiczny', done.token);

  // wyloguj wszystkie urządzenia: komputer i klucz klubu tracą dostęp, telefon (bieżący) zostaje
  const T = await connect(c.room, c.token);
  let markPC = PC.mark(), markT = T.mark();
  assert.ok((await P.req('logoutAll')).ok);
  await PC.wait((m) => m.t === 'authFailed', 5000, markPC);
  await T.wait((m) => m.t === 'authFailed', 5000, markT);
  assert.equal((await new Client(srv.base, 'publiczny', done.token).connect()).t, 'authFailed');
  assert.equal((await new Client(srv.base, c.room, c.token).connect()).t, 'authFailed');
  assert.ok((await P.req('accountInfo')).ok);
  P.close();
});

test('znajomi przez link (jednorazowy); usunięcie konta (RODO): klub przekazany albo usunięty, partie z „usunięty gracz”', async () => {
  // link do znajomych
  const [a, b, c] = [await register('La'), await register('Lb'), await register('Lc')];
  const A = await connect('publiczny', a.token), B = await connect('publiczny', b.token), C = await connect('publiczny', c.token);
  const { token } = await A.req('friendLinkCreate');
  assert.match((await A.req('friendLinkUse', { token })).error, /własny link/);
  assert.equal((await B.req('friendLinkInfo', { token })).nick, a.nick);
  const mark = A.mark();
  const used = await B.req('friendLinkUse', { token });
  assert.equal(used.social.friends[0].nick, a.nick);
  assert.equal((await A.wait((m) => m.t === 'event' && m.ev.type === 'friendJoined', 5000, mark)).ev.nick, b.nick);
  assert.match((await C.req('friendLinkUse', { token })).error, /nieaktualny/); // jednorazowy

  // A zakłada dwa kluby: jeden przekaże C, drugi usunie; B jest członkiem obu
  const k1 = await createClub('Klub przekazany', undefined, a);
  const k2 = await createClub('Klub do usunięcia', undefined, a);
  const jb1 = await joinClub(k1.code, { account: b });
  const jc1 = await joinClub(k1.code, { account: c });
  const jb2 = await joinClub(k2.code, { account: b });
  // partia w klubie, żeby sprawdzić anonimizację
  const W = await connect(k1.room, k1.token), Bl = await connect(k1.room, jb1.data.token);
  const ch = await W.req('challenge', { to: jb1.data.memberId, time: 10, increment: 0, color: 'white' });
  const gameId = (await Bl.req('accept', { id: ch.id })).gameId;
  await W.req('watch', { gameId }); await Bl.req('watch', { gameId });
  await playMoves(gameId, W, Bl, ['e2e4', 'e7e5']);
  await Bl.req('resign', { gameId });
  const B2 = await connect(k2.room, jb2.data.token);

  const owned = (await A.req('ownedClubs')).clubs;
  assert.deepEqual(owned.map((x) => x.name).sort(), ['Klub do usunięcia', 'Klub przekazany']);
  assert.deepEqual(owned.find((x) => x.room === k1.room).members.map((x) => x.nick), [b.nick, c.nick].sort((x, y) => x.localeCompare(y, 'pl')));
  assert.match((await A.req('deleteAccount', { password: 'zle' })).error, /Złe hasło/);
  assert.match((await A.req('deleteAccount', { password: a.password, decisions: { [k1.room]: jc1.data.memberId } })).error, /Zdecyduj/);
  const markB2 = B2.mark();
  const del = await A.req('deleteAccount', { password: a.password, decisions: { [k1.room]: jc1.data.memberId, [k2.room]: 'delete' } });
  assert.ok(del.ok, del.error);

  // konto nie istnieje, nick wolny
  assert.equal((await api(srv.base, 'POST', '/api/account/login', { nick: a.nick, password: a.password })).status, 400);
  assert.equal((await new Client(srv.base, 'publiczny', a.token).connect()).t, 'authFailed');
  assert.equal((await B.req('social')).social.friends.length, 0);
  // klub 1: C jest założycielem, partia z „usunięty gracz”
  const Cc = await connect(k1.room, jc1.data.token);
  assert.equal(Cc.welcome.room.role, 'owner');
  assert.equal(Cc.welcome.members.some((x) => x.nick === a.nick), false);
  assert.match((await Cc.req('gamePgn', { gameId })).pgn, /\[White "usunięty gracz"\]/);
  // klub 2: usunięty razem z kodem
  await B2.wait((m) => m.t === 'authFailed', 5000, markB2);
  assert.match((await joinClub(k2.code, { account: c })).data.error, /Nie ma klubu/);
  assert.equal((await B.req('myRooms')).rooms.some((r) => r.room === k2.room), false);
  for (const x of [B, C, W, Bl, Cc]) x.close();
});

test('moje zapisane gry: zapis partii i momentów (także Lichess), notatki, uwaga trenera dla obojga albo jednego, usuwanie', async () => {
  const acc = (path, body) => api(srv.base, 'POST', '/api/account/' + path, body);
  const p = await register('Ar');
  // partia z Lichess (ruchy z aplikacji) + moment z notatką w trakcie
  const lich = { source: 'lichess', ref: 'AbCd1234', roomName: 'Lichess', white: p.nick, black: 'rywal_l', myColor: 'white', result: '*', label: '10+5', moves: ['e2e4', 'e7e5'] };
  const m1 = await acc('moment-add', { accountToken: p.token, game: lich, ply: 2 });
  assert.equal(m1.status, 200, JSON.stringify(m1.data));
  assert.equal((await acc('moment-note', { accountToken: p.token, id: m1.data.id, note: 'czy bić na d5?' })).status, 200);
  // koniec partii: pełny zapis (ruchy dopisane, wynik)
  assert.equal((await acc('games-save', { accountToken: p.token, game: { ...lich, result: '1-0', status: 'mate', moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'] } })).data.id, m1.data.gameId);
  // zapis w trakcie z krótszą listą nie skraca partii
  await acc('games-save', { accountToken: p.token, game: { ...lich, moves: ['e2e4'] } });
  let g = (await acc('game-get', { accountToken: p.token, id: m1.data.gameId })).data;
  assert.equal(g.game.moves.length, 7);
  assert.deepEqual(g.moments.map((m) => [m.ply, m.note, m.kind]), [[2, 'czy bić na d5?', 'self']]);
  assert.match((await acc('games-list', { accountToken: 'zly' })).data.error, /konta/);

  // uwaga trenera w klubie: oboje graczy, potem tylko czarne
  const ctx = await clubWithTwo();
  const { gameId, W, Bl } = await startGame(ctx);
  await playMoves(gameId, W, Bl, ['e2e4', 'e7e5', 'g1f3']);
  const B = await connect('publiczny', ctx.b.token);
  const mark = B.mark();
  const r = await W.req('coachNote', { gameId, ply: 2, note: 'Tu lepsze było Nf3', to: 'both' });
  assert.ok(r.ok && r.saved === 2, JSON.stringify(r));
  assert.equal((await B.wait((m) => m.t === 'event' && m.ev.type === 'coachNote', 5000, mark)).ev.author, ctx.a.nick);
  assert.ok((await W.req('coachNote', { gameId, ply: 3, note: 'Tylko dla czarnych', to: 'black' })).ok);
  assert.equal((await Bl.req('coachNote', { gameId, ply: 1, note: 'x' })).ok, false); // tylko założyciel/admin
  const listB = (await acc('games-list', { accountToken: ctx.b.token })).data.games;
  const gb = listB.find((x) => x.ref === gameId);
  assert.deepEqual([gb.source, gb.moments, gb.coachNotes, gb.myColor], ['club', 2, 2, 'black']);
  const listA = (await acc('games-list', { accountToken: ctx.a.token })).data.games;
  assert.equal(listA.find((x) => x.ref === gameId).moments, 1);
  const full = (await acc('game-get', { accountToken: ctx.b.token, id: gb.id })).data;
  assert.equal(full.moments[0].author, ctx.a.nick);
  assert.match((await acc('moment-note', { accountToken: ctx.b.token, id: full.moments[0].id, note: 'zmiana' })).data.error, /trenera/);
  // moment można usunąć, partii z zapisanych — nie (zostają na stałe)
  assert.equal((await acc('moment-delete', { accountToken: ctx.b.token, id: full.moments[1].id })).status, 200);
  assert.equal((await acc('game-delete', { accountToken: p.token, id: m1.data.gameId })).status, 404);
  assert.equal((await acc('games-list', { accountToken: p.token })).data.games.length, 1);
  for (const x of [W, Bl, B]) x.close();
});

test('limity zakładania; ochrona: zalewanie, wewnętrzne akcje niedostępne', async () => {
  const ip = { 'X-Test-IP': 'test-limit-' + uniq() };
  const own = await register('Lim');
  for (let i = 0; i < 3; i++) assert.equal((await api(srv.base, 'POST', '/api/rooms', { name: 'L' + i, accountToken: own.token }, ip)).status, 200);
  assert.equal((await api(srv.base, 'POST', '/api/rooms', { name: 'L4', accountToken: own.token }, ip)).status, 400);
  const p = await register('Z');
  const P = await connect('publiczny', p.token);
  for (let i = 0; i < 60; i++) P.ws.send(JSON.stringify({ t: 'members', reqId: 1000 + i }));
  await P.wait((m) => m.t === 'error' && /Zbyt wiele/.test(m.message), 5000);
  const c = await createClub('Wewn', 'Ala');
  for (const [m, path] of [['POST', '/api/account/verify'], ['POST', `/api/rooms/${c.room}/join`], ['POST', '/api/account/rate'], ['GET', `/api/rooms/${c.room}`]]) {
    assert.equal((await api(srv.base, m, path, m === 'POST' ? {} : undefined)).status, 404, path);
  }
});

test('panel trenera i administratora: podgląd partii, PGN', async () => {
  const c = await createClub('Szkółka PGN', 'Trener');
  const T = await connect(c.room, c.token);
  const ja = await joinClub(c.code, { nick: 'Jaś' }), ma = await joinClub(c.code, { nick: 'Małgosia' });
  const J = await connect(c.room, ja.data.token), M = await connect(c.room, ma.data.token);
  const ch = await J.req('challenge', { to: ma.data.memberId, time: 10, increment: 0, color: 'white' });
  const gameId = (await M.req('accept', { id: ch.id })).gameId;
  await J.req('watch', { gameId }); await M.req('watch', { gameId });
  assert.ok((await T.req('watch', { gameId })).ok);
  assert.equal((await gm(T, gameId, 'full')).spectator, true);
  assert.equal((await M.req('coachPanel')).ok, false);
  await playMoves(gameId, J, M, ['e2e4', 'e7e5', 'g1f3']);
  const mark = J.mark();
  await M.req('resign', { gameId });
  await gm(J, gameId, 'state', mark);
  assert.match((await J.req('gamePgn', { gameId })).pgn, /1\. e4 e5 2\. Nf3 1-0$/);
  assert.ok((await T.req('setRole', { id: ma.data.memberId, role: 'admin' })).ok);
  const panel = await M.req('coachPanel');
  assert.equal(panel.members.find((x) => x.nick === 'Jaś').wins, 1);
  for (const x of [T, J, M]) x.close();
});

test('statystyki z kluczem', async () => {
  assert.equal((await api(srv.base, 'GET', '/api/stats', undefined, { Authorization: 'Bearer zly' })).status, 400);
  const s = await api(srv.base, 'GET', '/api/stats', undefined, KEY);
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.ok(s.data.totals.game >= 1 && s.data.days.length === 30);
});

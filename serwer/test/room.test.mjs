// Testy serwera pokoi na lokalnym `wrangler dev` (TEST_MODE=1 z .dev.vars: krótkie limity).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, Client, sleep } from './helpers.mjs';
import { rateGame, DEFAULT } from '../src/glicko.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

async function roomWithTwo() {
  const c = await api(srv.base, 'POST', '/api/rooms', { name: 'Klub testowy', nick: 'Ania' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const j = await api(srv.base, 'POST', `/api/rooms/${c.data.room}/join`, { nick: 'Bartek' });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  const A = new Client(srv.base, c.data.room, c.data.token);
  const B = new Client(srv.base, c.data.room, j.data.token);
  await A.connect(); await B.connect();
  return { room: c.data.room, A, B, aId: c.data.memberId, bId: j.data.memberId, bToken: j.data.token };
}

// A wyzywa B, B przyjmuje. Zwraca id partii i kto gra białymi.
async function startGame(ctx, { time = 10, increment = 5, rated = true, color = 'white' } = {}) {
  const { A, B, bId } = ctx;
  const ch = await A.req('challenge', { to: bId, time, increment, rated, color });
  assert.ok(ch.ok, ch.error);
  const ev = await B.wait((m) => m.t === 'event' && m.ev.type === 'challenge' && m.ev.challenge.id === ch.id);
  assert.equal(ev.ev.challenge.from, 'Ania');
  const acc = await B.req('accept', { id: ch.id });
  assert.ok(acc.ok, acc.error);
  await A.wait((m) => m.t === 'challengeResult' && m.id === ch.id && m.result === 'accepted');
  const gs = await A.wait((m) => m.t === 'event' && m.ev.type === 'gameStart' && m.ev.game.id === acc.gameId);
  const gameId = acc.gameId;
  await A.req('watch', { gameId }); await B.req('watch', { gameId });
  const W = gs.ev.game.color === 'white' ? A : B;
  const Bl = W === A ? B : A;
  return { gameId, W, Bl };
}

test('Glicko-2: wygrana podnosi, przegrana obniża; suma bliska zera', () => {
  const r = rateGame({ ...DEFAULT }, { ...DEFAULT }, 1);
  assert.ok(r.white.rating > 1600 && r.white.rating < 1700, String(r.white.rating));
  assert.ok(Math.abs(r.white.rating - 1500 + (r.black.rating - 1500)) < 1);
  assert.ok(r.white.rd < 350);
});

test('pokój: tworzenie, informacja, dołączanie, zajęty nick, zły token', async () => {
  const c = await api(srv.base, 'POST', '/api/rooms', { name: 'Szkółka', nick: 'Trener' });
  assert.equal(c.status, 200);
  assert.match(c.data.room, /^[a-z2-9]{12}$/);
  const info = await api(srv.base, 'GET', `/api/rooms/${c.data.room}`);
  assert.deepEqual(info.data, { name: 'Szkółka', members: 1, public: false });
  const dup = await api(srv.base, 'POST', `/api/rooms/${c.data.room}/join`, { nick: 'trener' });
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /zajęty/);
  const bad = await api(srv.base, 'POST', `/api/rooms/${c.data.room}/join`, { nick: 'x' });
  assert.equal(bad.status, 400);
  const none = await api(srv.base, 'GET', '/api/rooms/aaaaaaaaaaaa');
  assert.equal(none.status, 404);
  const X = new Client(srv.base, c.data.room, 'zly-token');
  const w = await X.connect();
  assert.equal(w.t, 'authFailed');
  const T = new Client(srv.base, c.data.room, c.data.token);
  const ok = await T.connect();
  assert.equal(ok.me.name, 'Trener');
  assert.equal(ok.room.name, 'Szkółka');
  T.close();
});

test('partia 10+5: ruchy w obie strony, serwer odrzuca ruch nielegalny, zegar, ranking i historia', async () => {
  const ctx = await roomWithTwo();
  const { gameId, W, Bl } = await startGame(ctx);
  assert.equal(W, ctx.A); // A wyzwał białymi

  const full = await W.gameMsg(gameId, 'full');
  assert.equal(full.clock.initial, 600000);
  assert.equal(full.clock.increment, 5000);
  assert.equal(full.white.name, 'Ania');

  // nie swój ruch i ruch nielegalny
  let r = await Bl.req('move', { gameId, uci: 'e7e5', ply: 0 });
  assert.equal(r.ok, false); assert.match(r.error, /nie Twój/);
  r = await W.req('move', { gameId, uci: 'e2e5', ply: 0 });
  assert.equal(r.ok, false); assert.match(r.error, /niedozwolony/);

  let mark = Bl.mark();
  r = await W.req('move', { gameId, uci: 'e2e4', ply: 0 });
  assert.ok(r.ok, r.error);
  let st = await Bl.gameMsg(gameId, 'state', mark);
  assert.deepEqual(st.state.moves, ['e2e4']);
  // ponowne wysłanie tego samego ruchu (po zerwaniu) nie gra go drugi raz
  r = await W.req('move', { gameId, uci: 'e2e4', ply: 0 });
  assert.ok(r.ok && r.duplicate);

  mark = W.mark();
  r = await Bl.req('move', { gameId, uci: 'e7e5', ply: 1 });
  assert.ok(r.ok, r.error);
  st = await W.gameMsg(gameId, 'state', mark);
  assert.deepEqual(st.state.moves, ['e2e4', 'e7e5']);
  assert.ok(st.state.wtime > 599000 && st.state.wtime <= 600000); // zegar białych właśnie ruszył

  // zegar białych biegnie od 3. półruchu
  await sleep(1200);
  mark = Bl.mark();
  r = await W.req('move', { gameId, uci: 'g1f3', ply: 2 });
  st = await Bl.gameMsg(gameId, 'state', mark);
  const spent = 600000 + 5000 - st.state.wtime;
  assert.ok(spent >= 1100 && spent < 2500, `zużyto ${spent} ms`);

  // roszada zapisana jako „król na wieżę” jest zamieniana
  await Bl.req('move', { gameId, uci: 'b8c6', ply: 3 });
  await W.req('move', { gameId, uci: 'f1c4', ply: 4 });
  await Bl.req('move', { gameId, uci: 'g8f6', ply: 5 });
  mark = Bl.mark();
  r = await W.req('move', { gameId, uci: 'e1h1', ply: 6 });
  assert.ok(r.ok, r.error);
  st = await Bl.gameMsg(gameId, 'state', mark);
  assert.equal(st.state.moves[6], 'e1g1');

  // remis: propozycja i odrzucenie
  mark = W.mark();
  await Bl.req('draw', { gameId, yes: true });
  st = await W.gameMsg(gameId, 'state', mark);
  assert.equal(st.state.bdraw, true);
  await W.req('draw', { gameId, yes: false });

  // przerwać już nie można, poddać tak
  r = await W.req('abort', { gameId });
  assert.equal(r.ok, false);
  mark = W.mark();
  r = await Bl.req('resign', { gameId });
  assert.ok(r.ok, r.error);
  st = await W.gameMsg(gameId, 'state', mark);
  assert.equal(st.state.status, 'resign');
  assert.equal(st.state.winner, 'white');
  await W.wait((m) => m.t === 'event' && m.ev.type === 'gameFinish', 5000, mark);

  const mem = await W.req('members');
  const a = mem.members.find((m) => m.nick === 'Ania');
  const b = mem.members.find((m) => m.nick === 'Bartek');
  assert.ok(a.ratings.rapid.rating > 1500 && b.ratings.rapid.rating < 1500);
  assert.equal(a.ratings.rapid.games, 1);
  assert.equal(a.ratings.blitz.games, 0); // osobno wg tempa

  const h = await W.req('history');
  assert.equal(h.games[0].id, gameId);
  assert.ok(h.games[0].diffW > 0 && h.games[0].diffB < 0);
  ctx.A.close(); ctx.B.close();
});

test('ponowne połączenie: partia trwa, zegar zgodny z serwerem', async () => {
  const ctx = await roomWithTwo();
  const { gameId, W, Bl } = await startGame(ctx, { rated: false });
  await W.req('move', { gameId, uci: 'd2d4', ply: 0 });
  await Bl.req('move', { gameId, uci: 'd7d5', ply: 1 });
  await W.req('move', { gameId, uci: 'c2c4', ply: 2 });
  // czarne rozłączają się na 3 s; ich zegar biegnie dalej
  Bl.close();
  await sleep(3000);
  const back = new Client(srv.base, ctx.room, ctx.bToken);
  const wel = await back.connect();
  assert.equal(wel.ongoing.length, 1);
  await back.req('watch', { gameId });
  const full = await back.gameMsg(gameId, 'full');
  assert.deepEqual(full.state.moves, ['d2d4', 'd7d5', 'c2c4']);
  const lost = 600000 - full.state.btime;
  assert.ok(lost >= 2900 && lost < 4500, `czarne straciły ${lost} ms`);
  const r = await back.req('move', { gameId, uci: 'e7e6', ply: 3 });
  assert.ok(r.ok, r.error);
  back.close(); W.close();
});

test('koniec czasu ogłasza serwer (alarm), bez udziału klienta', async () => {
  const ctx = await roomWithTwo();
  const { gameId, W, Bl } = await startGame(ctx, { time: 0.05, increment: 0, rated: false }); // 3 s
  await W.req('move', { gameId, uci: 'e2e4', ply: 0 });
  await Bl.req('move', { gameId, uci: 'e7e5', ply: 1 });
  const mark = W.mark();
  const st = await W.wait((m) => m.t === 'game' && m.msg.type === 'state' && m.msg.state.status === 'outoftime', 8000, mark);
  assert.equal(st.msg.state.winner, 'black');
  assert.equal(st.msg.state.wtime, 0);
  W.close(); Bl.close();
});

test('wyjście rywala: powiadomienie, potem odebranie zwycięstwa', async () => {
  const ctx = await roomWithTwo();
  const { gameId, W, Bl } = await startGame(ctx, { rated: false });
  await W.req('move', { gameId, uci: 'e2e4', ply: 0 });
  await Bl.req('move', { gameId, uci: 'c7c5', ply: 1 });
  const mark = W.mark();
  Bl.close();
  const g1 = await W.wait((m) => m.t === 'game' && m.msg.type === 'opponentGone' && m.msg.gone, 6000, mark);
  assert.ok(g1.msg.claimWinInSeconds > 0);
  let r = await W.req('claimVictory', { gameId });
  assert.equal(r.ok, false);
  await W.wait((m) => m.t === 'game' && m.msg.type === 'opponentGone' && m.msg.claimWinInSeconds === 0, 6000, mark);
  r = await W.req('claimVictory', { gameId });
  assert.ok(r.ok, r.error);
  const st = await W.wait((m) => m.t === 'game' && m.msg.type === 'state' && m.msg.state.status === 'timeout', 3000, mark);
  assert.equal(st.msg.state.winner, 'white');
  W.close();
});

test('wyzwanie: odrzucenie, anulowanie, przerwanie przed ruchem', async () => {
  const ctx = await roomWithTwo();
  const { A, B, bId } = ctx;
  let ch = await A.req('challenge', { to: bId, time: 5, increment: 3, rated: true });
  await B.req('decline', { id: ch.id });
  await A.wait((m) => m.t === 'challengeResult' && m.id === ch.id && m.result === 'declined');
  ch = await A.req('challenge', { to: bId, time: 5, increment: 3, rated: true });
  await A.req('cancel', { id: ch.id });
  await B.wait((m) => m.t === 'event' && m.ev.type === 'challengeGone' && m.ev.id === ch.id);
  const bad = await A.req('challenge', { to: bId, days: 3 });
  assert.equal(bad.ok, false);

  const { gameId, W, Bl } = await startGame(ctx, { time: 3, increment: 2 });
  const full = await W.gameMsg(gameId, 'full');
  assert.equal(full.speed, 'blitz');
  await W.req('move', { gameId, uci: 'e2e4', ply: 0 });
  let r = await W.req('abort', { gameId });
  assert.equal(r.ok, false); // białe już zagrały
  const mark = W.mark();
  r = await Bl.req('abort', { gameId });
  assert.ok(r.ok, r.error);
  const st = await W.wait((m) => m.t === 'game' && m.msg.type === 'state' && m.msg.state.status === 'aborted', 3000, mark);
  assert.equal(st.msg.state.winner, null);
  const mem = await W.req('members');
  assert.equal(mem.members.find((m) => m.nick === 'Ania').ratings.blitz.games, 0);
  A.close(); B.close();
});

test('przeniesienie na inne urządzenie: jednorazowy kod', async () => {
  const ctx = await roomWithTwo();
  const t = await ctx.B.req('transferCreate');
  assert.ok(t.ok && t.code);
  const claim = await api(srv.base, 'POST', `/api/rooms/${ctx.room}/transfer`, { code: t.code });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  assert.equal(claim.data.nick, 'Bartek');
  const again = await api(srv.base, 'POST', `/api/rooms/${ctx.room}/transfer`, { code: t.code });
  assert.equal(again.status, 410);
  const D2 = new Client(srv.base, ctx.room, claim.data.token);
  const w = await D2.connect();
  assert.equal(w.me.id, ctx.bId);
  // wylogowanie unieważnia token tylko tego urządzenia
  await D2.req('logout');
  const D3 = new Client(srv.base, ctx.room, claim.data.token);
  assert.equal((await D3.connect()).t, 'authFailed');
  const old = new Client(srv.base, ctx.room, ctx.bToken);
  assert.equal((await old.connect()).t, 'welcome');
  old.close(); ctx.A.close(); ctx.B.close();
});

// --- poczekalnia i automatyczne parowanie ----------------------------------------
const uniq = () => Math.random().toString(36).slice(2, 8);

async function publicPlayer(nick) {
  const j = await api(srv.base, 'POST', '/api/account/register', { nick, password: 'gracz-testowy-' + uniq() });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  const c = new Client(srv.base, 'publiczny', j.data.token);
  await c.connect();
  return { c, id: j.data.memberId, token: j.data.token };
}

test('poczekalnia ogólna: tworzy się sama, parowanie tego samego tempa', async () => {
  const info = await api(srv.base, 'GET', '/api/rooms/publiczny');
  assert.equal(info.data.name, 'Poczekalnia ogólna');
  assert.equal(info.data.public, true);
  const P = await publicPlayer('P' + uniq());
  const Q = await publicPlayer('Q' + uniq());
  const R = await publicPlayer('R' + uniq());
  assert.equal(P.c.welcome.room.public, true);

  // P szuka 10+5 rankingowej, R szuka 3+2 — nie łączą się
  const sp = await P.c.req('seek', { time: 10, increment: 5, rated: true });
  assert.ok(sp.ok && sp.id && !sp.matched);
  const sr = await R.c.req('seek', { time: 3, increment: 2, rated: true });
  assert.ok(sr.ok && !sr.matched);
  const list = await Q.c.wait((m) => m.t === 'seeks' && m.seeks.some((s) => s.id === sp.id) && m.seeks.some((s) => s.id === sr.id));
  assert.equal(list.seeks.find((s) => s.id === sp.id).label, '10+5');

  // Q szuka 10+5 → para z P natychmiast
  const markP = P.c.mark();
  const sq = await Q.c.req('seek', { time: 10, increment: 5, rated: true });
  assert.ok(sq.ok && sq.matched && sq.gameId);
  await P.c.wait((m) => m.t === 'event' && m.ev.type === 'gameStart' && m.ev.game.id === sq.gameId, 5000, markP);
  await P.c.wait((m) => m.t === 'seekResult' && m.id === sp.id && m.result === 'accepted', 5000, markP);
  const after = await R.c.req('members');
  assert.ok(after.ok);

  // szukanie R znika, gdy R się rozłącza
  const markQ = Q.c.mark();
  R.c.close();
  await Q.c.wait((m) => m.t === 'seeks' && !m.seeks.some((s) => s.id === sr.id), 5000, markQ);

  // historia w poczekalni: tylko własne partie
  await P.c.req('watch', { gameId: sq.gameId });
  await P.c.req('abort', { gameId: sq.gameId });
  const hp = await P.c.req('history');
  assert.ok(hp.games.every((g) => g.whiteId === P.id || g.blackId === P.id));
  P.c.close(); Q.c.close();
});

test('poczekalnia: dołączenie do wystawionego szukania, anulowanie', async () => {
  const P = await publicPlayer('S' + uniq());
  const Q = await publicPlayer('T' + uniq());
  const sp = await P.c.req('seek', { time: 5, increment: 3, rated: false });
  let r = await P.c.req('seekAccept', { id: sp.id });
  assert.equal(r.ok, false);
  r = await Q.c.req('seekAccept', { id: sp.id });
  assert.ok(r.ok && r.gameId, r.error);
  await P.c.wait((m) => m.t === 'seekResult' && m.id === sp.id);
  const s2 = await P.c.req('seek', { time: 15, increment: 10, rated: true });
  const mark = Q.c.mark();
  await P.c.req('seekCancel', { id: s2.id });
  await Q.c.wait((m) => m.t === 'seeks' && !m.seeks.some((s) => s.id === s2.id), 5000, mark);
  r = await Q.c.req('seekAccept', { id: s2.id });
  assert.equal(r.ok, false);
  P.c.close(); Q.c.close();
});

test('parowanie działa też w prywatnym pokoju', async () => {
  const ctx = await roomWithTwo();
  const s = await ctx.A.req('seek', { time: 10, increment: 0, rated: true });
  assert.ok(!s.matched);
  const m = await ctx.B.req('seek', { time: 10, increment: 0, rated: true });
  assert.ok(m.matched);
  ctx.A.close(); ctx.B.close();
});

// --- konta ---------------------------------------------------------------------------
test('konto: rejestracja, logowanie na innym urządzeniu, blokada po błędnych hasłach', async () => {
  const nick = 'K' + uniq();
  const r = await api(srv.base, 'POST', '/api/account/register', { nick, password: 'tajne-haslo-1', email: nick + '@example.com' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const short = await api(srv.base, 'POST', '/api/account/register', { nick: 'X' + uniq(), password: 'krotkie' });
  assert.equal(short.status, 400);
  const dupMail = await api(srv.base, 'POST', '/api/account/register', { nick: 'Y' + uniq(), password: 'tajne-haslo-1', email: nick.toUpperCase() + '@example.com' });
  assert.match(dupMail.data.error, /e-mail/);

  const bad = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'zle-haslo-xx' });
  assert.equal(bad.status, 400);
  const ok = await api(srv.base, 'POST', '/api/account/login', { nick: nick.toLowerCase(), password: 'tajne-haslo-1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.memberId, r.data.memberId);
  const C = new Client(srv.base, 'publiczny', ok.data.token);
  const w = await C.connect();
  assert.equal(w.me.hasPassword, true);
  assert.equal(w.me.email, nick + '@example.com');
  C.close();

  // 3 błędne próby (tryb testowy) → blokada, także dla dobrego hasła; po 3 s znów działa
  for (let i = 0; i < 3; i++) await api(srv.base, 'POST', '/api/account/login', { nick, password: 'zle-haslo-xx' });
  const locked = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'tajne-haslo-1' });
  assert.match(locked.data.error, /Za dużo/);
  await sleep(3200);
  const again = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'tajne-haslo-1' });
  assert.equal(again.status, 200, JSON.stringify(again.data));
});

test('konto: zmiana hasła wylogowuje inne urządzenia, to zostaje; poczekalnia tylko z kontem', async () => {
  const nick = 'Z' + uniq();
  const reg = await api(srv.base, 'POST', '/api/account/register', { nick, password: 'pierwsze-haslo' });
  const other = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'pierwsze-haslo' }); // drugie urządzenie
  const P = new Client(srv.base, 'publiczny', reg.data.token);
  await P.connect();
  let r = await P.req('setPassword', { password: 'drugie-haslo-x', oldPassword: 'zle' });
  assert.equal(r.ok, false);
  r = await P.req('setPassword', { password: 'drugie-haslo-x', oldPassword: 'pierwsze-haslo' });
  assert.ok(r.ok, r.error);
  const old = new Client(srv.base, 'publiczny', other.data.token);
  assert.equal((await old.connect()).t, 'authFailed'); // drugie urządzenie wylogowane
  const same = new Client(srv.base, 'publiczny', reg.data.token);
  assert.equal((await same.connect()).t, 'welcome'); // to urządzenie zostaje
  const login = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'drugie-haslo-x' });
  assert.equal(login.data.memberId, reg.data.memberId); // to samo konto = ten sam ranking
  const join = await api(srv.base, 'POST', '/api/rooms/publiczny/join', { nick: 'B' + uniq() });
  assert.match(join.data.error, /potrzebne jest konto/);
  P.close(); same.close();
});

test('hasła: popularne, proste i z nickiem odrzucone; nick z obcego alfabetu odrzucony', async () => {
  for (const pw of ['qwerty123', 'Haslo123', '12345678', 'aaaaaaaa', 'abcabcabc', 'zaq12wsx', 'SZACHY123']) {
    const r = await api(srv.base, 'POST', '/api/account/register', { nick: 'H' + uniq(), password: pw });
    assert.equal(r.status, 400, pw);
    assert.match(r.data.error, /popularne|proste/, pw);
  }
  const n = 'Ola' + uniq();
  const withNick = await api(srv.base, 'POST', '/api/account/register', { nick: n, password: 'xx' + n + 'yy' });
  assert.match(withNick.data.error, /nicku/);
  const cyr = await api(srv.base, 'POST', '/api/account/register', { nick: 'Аnia' + uniq(), password: 'dobre-haslo-77' }); // cyrylickie А
  assert.equal(cyr.status, 400);
  const pl = await api(srv.base, 'POST', '/api/account/register', { nick: 'Łucja' + uniq().slice(0, 3), password: 'dobre-haslo-77' });
  assert.equal(pl.status, 200, JSON.stringify(pl.data));
});

test('limity: zakładanie kont i pokoi z jednej sieci, blokada logowania tylko dla tej sieci', async () => {
  const ip = { 'X-Test-IP': 'test-limit-' + uniq() };
  for (let i = 0; i < 3; i++) {
    const r = await api(srv.base, 'POST', '/api/account/register', { nick: 'Lim' + uniq(), password: 'limit-haslo-9' }, ip);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const fourth = await api(srv.base, 'POST', '/api/account/register', { nick: 'Lim' + uniq(), password: 'limit-haslo-9' }, ip);
  assert.match(fourth.data.error, /zbyt wiele kont/);
  const elsewhere = await api(srv.base, 'POST', '/api/account/register', { nick: 'Lim' + uniq(), password: 'limit-haslo-9' }, { 'X-Test-IP': 'test-limit-' + uniq() });
  assert.equal(elsewhere.status, 200);

  const rip = { 'X-Test-IP': 'test-limit-' + uniq() };
  for (let i = 0; i < 3; i++) assert.equal((await api(srv.base, 'POST', '/api/rooms', { name: 'P' + i, nick: 'Ala' }, rip)).status, 200);
  const room4 = await api(srv.base, 'POST', '/api/rooms', { name: 'P4', nick: 'Ala' }, rip);
  assert.equal(room4.status, 429);
  assert.match(room4.data.error, /zbyt wiele pokoi/);

  // blokada po błędnych hasłach dotyczy tylko sieci, z której zgadywano
  const nick = 'Blk' + uniq();
  await api(srv.base, 'POST', '/api/account/register', { nick, password: 'blokada-haslo-1' });
  const bad = { 'X-Test-IP': 'zgadywacz-' + uniq() };
  for (let i = 0; i < 3; i++) await api(srv.base, 'POST', '/api/account/login', { nick, password: 'zle-zle-zle' }, bad);
  assert.match((await api(srv.base, 'POST', '/api/account/login', { nick, password: 'blokada-haslo-1' }, bad)).data.error, /Za dużo/);
  const mine = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'blokada-haslo-1' }, { 'X-Test-IP': 'wlasciciel-' + uniq() });
  assert.equal(mine.status, 200);
});

test('ochrona: zalewanie wiadomościami rozłącza, wewnętrzne akcje niedostępne', async () => {
  const P = await publicPlayer('F' + uniq());
  for (let i = 0; i < 60; i++) P.c.ws.send(JSON.stringify({ t: 'members', reqId: 1000 + i }));
  await P.c.wait((m) => m.t === 'error' && /Zbyt wiele/.test(m.message), 5000);
  await sleep(300);
  assert.equal(P.c.closed, true);
  const pub = await api(srv.base, 'POST', '/api/rooms/publiczny/account-login', { accountToken: 'x' });
  assert.equal(pub.status, 404);
  for (const p of ['/api/account/verify', '/api/account/limit', '/api/account/room-add']) {
    assert.equal((await api(srv.base, 'POST', p, {})).status, 404, p);
  }
});

test('konto: odzyskiwanie hasła linkiem (e-mail wyłączony lokalnie, token testowy)', async () => {
  const nick = 'R' + uniq();
  await api(srv.base, 'POST', '/api/account/register', { nick, password: 'stare-haslo-1', email: nick + '@example.org' });
  const none = await api(srv.base, 'POST', '/api/account/reset-request', { login: 'nie-ma-' + uniq() });
  assert.deepEqual(none.data, { ok: true, mailEnabled: false });
  const req = await api(srv.base, 'POST', '/api/account/reset-request', { login: nick + '@EXAMPLE.org' });
  assert.ok(req.data.debugToken);
  const done = await api(srv.base, 'POST', '/api/account/reset', { token: req.data.debugToken, password: 'nowe-haslo-12' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const reuse = await api(srv.base, 'POST', '/api/account/reset', { token: req.data.debugToken, password: 'inne-haslo-12' });
  assert.equal(reuse.status, 400);
  const login = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'nowe-haslo-12' });
  assert.equal(login.status, 200);
});

test('konto + pokój: pokój zapamiętany na koncie, wejście na nowym urządzeniu po zalogowaniu', async () => {
  const nick = 'M' + uniq();
  const reg = await api(srv.base, 'POST', '/api/account/register', { nick, password: 'haslo-pokoju-1' });
  const room = await api(srv.base, 'POST', '/api/rooms', { name: 'Klub konta', accountToken: reg.data.token });
  assert.equal(room.status, 200, JSON.stringify(room.data));
  assert.equal(room.data.nick, nick); // nick z konta

  // drugi gracz z kontem dołącza linkiem bez wpisywania nicku
  const n2 = 'N' + uniq();
  const reg2 = await api(srv.base, 'POST', '/api/account/register', { nick: n2, password: 'haslo-pokoju-2' });
  const j = await api(srv.base, 'POST', `/api/rooms/${room.data.room}/join`, { accountToken: reg2.data.token });
  assert.equal(j.data.nick, n2);
  const j2 = await api(srv.base, 'POST', `/api/rooms/${room.data.room}/join`, { accountToken: reg2.data.token });
  assert.equal(j2.data.memberId, j.data.memberId); // ponowne dołączenie = ten sam nick

  // nowe urządzenie: logowanie → lista pokoi → wejście do pokoju
  const login = await api(srv.base, 'POST', '/api/account/login', { nick, password: 'haslo-pokoju-1' });
  assert.deepEqual(login.data.rooms.map((x) => x.code), [room.data.room]);
  const back = await api(srv.base, 'POST', `/api/rooms/${room.data.room}/account-login`, { accountToken: login.data.token });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.memberId, room.data.memberId);
  const stranger = await api(srv.base, 'POST', '/api/account/register', { nick: 'O' + uniq(), password: 'haslo-obcego-1' });
  const deny = await api(srv.base, 'POST', `/api/rooms/${room.data.room}/account-login`, { accountToken: stranger.data.token });
  assert.equal(deny.status, 404);
  const fake = await api(srv.base, 'POST', `/api/rooms/${room.data.room}/account-login`, { accountToken: 'falszywy' });
  assert.equal(fake.status, 400);
  // wewnętrzne akcje nie są dostępne z zewnątrz
  const internal = await api(srv.base, 'POST', '/api/account/verify', { token: login.data.token });
  assert.equal(internal.status, 404);
});

test('konto + pokój: połączenie istniejącego nicku w pokoju z kontem', async () => {
  const ctx = await roomWithTwo();
  const reg = await api(srv.base, 'POST', '/api/account/register', { nick: 'L' + uniq(), password: 'haslo-laczenia' });
  const r = await ctx.B.req('linkAccount', { accountToken: reg.data.token });
  assert.ok(r.ok && r.linked, r.error);
  const login = await api(srv.base, 'POST', '/api/account/login', { nick: reg.data.nick, password: 'haslo-laczenia' });
  assert.equal(login.data.rooms[0].code, ctx.room);
  const back = await api(srv.base, 'POST', `/api/rooms/${ctx.room}/account-login`, { accountToken: login.data.token });
  assert.equal(back.data.nick, 'Bartek');
  ctx.A.close(); ctx.B.close();
});

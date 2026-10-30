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
  assert.deepEqual(info.data, { name: 'Szkółka', members: 1 });
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

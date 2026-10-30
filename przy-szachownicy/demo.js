// Dostawca demo: partia z prostym komputerem w przeglądarce, bez logowania i bez rankingu.
import { Chess } from './chess.js';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function botMove(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    let score = Math.random() * 0.6;
    if (m.captured) score += VALUE[m.captured] * 1.2;
    if (m.promotion) score += VALUE[m.promotion];
    chess.move(m);
    if (chess.isCheckmate()) score += 1000;
    else if (chess.inCheck()) score += 0.3;
    if (chess.isDraw()) score -= 2;
    // najgorsza odpowiedź przeciwnika: najcenniejsze bicie
    let worst = 0;
    for (const r of chess.moves({ verbose: true })) {
      if (r.captured) worst = Math.max(worst, VALUE[r.captured]);
      if (worst >= 9) break;
    }
    score -= worst;
    chess.undo();
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

export class DemoProvider {
  constructor() {
    this.name = 'demo';
    this.isDemo = true;
    this.games = new Map();
    this.onEvent = () => {};
    this.seq = 1;
  }

  hasToken() { return true; }
  async login() {}
  async handleRedirect() { return false; }
  async logout() { this.games.forEach((g) => clearInterval(g.timer)); this.games.clear(); }

  async account() {
    return { id: 'gosc', name: 'Gość (demo)', ratings: {} };
  }

  async ongoing() {
    return [...this.games.values()].filter((g) => g.status === 'started').map((g) => this._info(g));
  }

  startEvents(onEvent) { this.onEvent = onEvent; setTimeout(() => onEvent({ type: 'streamStatus', ok: true }), 0); }
  stopEvents() {}

  _info(g) {
    return {
      id: g.id, color: g.myColor,
      opponent: { name: 'Komputer demo', rating: null, ai: 1 },
      isMyTurn: g.chess.turn() === g.myColor[0],
      speed: g.days ? 'correspondence' : 'rapid', rated: false, boardCompatible: true,
    };
  }

  _create({ time, increment, days, color }) {
    const id = 'demo' + this.seq++;
    let myColor = color && color !== 'random' ? color : (Math.random() < 0.5 ? 'white' : 'black');
    const initial = days ? days * 86400000 : time * 60000;
    const g = {
      id, myColor, chess: new Chess(), uci: [],
      days: days || null,
      clock: days ? null : { initial, increment: (increment || 0) * 1000 },
      wtime: initial, btime: initial, lastAt: Date.now(),
      status: 'started', winner: null, wdraw: false, bdraw: false,
      listeners: new Set(), timer: null,
    };
    this.games.set(id, g);
    g.timer = setInterval(() => this._tickFlag(g), 500);
    setTimeout(() => {
      this.onEvent({ type: 'gameStart', game: this._info(g) });
      if (myColor === 'black') this._scheduleBot(g);
    }, 300);
    return g;
  }

  async seek(opts) {
    const g = this._create(opts);
    return { cancel: () => {}, done: Promise.resolve(g.id) };
  }
  async challenge(_name, opts) { return this.seek(opts); }
  async challengeAI(opts) { const g = this._create(opts); return { gameId: g.id }; }
  async acceptChallenge() {}
  async declineChallenge() {}

  _state(g) {
    const live = this._liveTimes(g);
    return {
      moves: [...g.uci], wtime: live.wtime, btime: live.btime,
      winc: g.clock?.increment || 0, binc: g.clock?.increment || 0,
      status: g.status, winner: g.winner, wdraw: g.wdraw, bdraw: g.bdraw,
    };
  }
  _liveTimes(g) {
    let { wtime, btime } = g;
    if (g.status === 'started' && g.uci.length >= 2) {
      const el = Date.now() - g.lastAt;
      if (g.chess.turn() === 'w') wtime -= el; else btime -= el;
    }
    return { wtime: Math.max(0, wtime), btime: Math.max(0, btime) };
  }
  _emit(g) {
    const st = this._state(g);
    g.listeners.forEach((fn) => fn({ type: 'state', state: st }));
    if (g.status !== 'started') {
      clearInterval(g.timer);
      g.listeners.forEach((fn) => fn({ type: 'end' }));
      this.onEvent({ type: 'gameFinish', game: this._info(g) });
    }
  }
  _tickFlag(g) {
    if (g.status !== 'started' || !g.clock) return;
    const t = this._liveTimes(g);
    if (t.wtime <= 0 || t.btime <= 0) {
      g.wtime = t.wtime; g.btime = t.btime;
      g.status = 'outoftime';
      g.winner = t.wtime <= 0 ? 'black' : 'white';
      this._emit(g);
    }
  }

  _apply(g, uci) {
    const from = uci.slice(0, 2), to = uci.slice(2, 4), promotion = uci[4];
    const mover = g.chess.turn();
    g.chess.move({ from, to, promotion });
    // zegar
    if (g.uci.length >= 2 && g.clock) {
      const el = Date.now() - g.lastAt;
      if (mover === 'w') g.wtime = g.wtime - el + g.clock.increment;
      else g.btime = g.btime - el + g.clock.increment;
    }
    g.lastAt = Date.now();
    g.uci.push(uci);
    g.wdraw = false; g.bdraw = false;
    if (g.chess.isCheckmate()) { g.status = 'mate'; g.winner = mover === 'w' ? 'white' : 'black'; }
    else if (g.chess.isStalemate()) g.status = 'stalemate';
    else if (g.chess.isDraw()) g.status = 'draw';
  }

  _scheduleBot(g) {
    const delay = 900 + Math.random() * 1800;
    setTimeout(() => {
      if (g.status !== 'started') return;
      if (g.chess.turn() === g.myColor[0]) return;
      const m = botMove(g.chess);
      if (!m) return;
      this._apply(g, m.from + m.to + (m.promotion || ''));
      this._emit(g);
    }, delay);
  }

  streamGame(id, onMsg) {
    const g = this.games.get(id);
    if (!g) { setTimeout(() => onMsg({ type: 'error', message: 'Nie znaleziono partii.' }), 0); return { close() {} }; }
    const me = { name: 'Ty (demo)', rating: null, ai: null };
    const bot = { name: 'Komputer demo', rating: null, ai: 1 };
    setTimeout(() => {
      onMsg({ type: 'connection', ok: true });
      onMsg({
        type: 'full', id,
        white: g.myColor === 'white' ? me : bot,
        black: g.myColor === 'black' ? me : bot,
        speed: g.days ? 'correspondence' : 'rapid', rated: false,
        clock: g.clock, daysPerTurn: g.days, initialFen: 'startpos',
        state: this._state(g),
      });
      if (g.status !== 'started') onMsg({ type: 'end' });
    }, 0);
    g.listeners.add(onMsg);
    return { close: () => g.listeners.delete(onMsg) };
  }

  async move(id, uci) {
    const g = this.games.get(id);
    if (!g || g.status !== 'started') throw new Error('Partia nie trwa.');
    if (g.chess.turn() !== g.myColor[0]) throw new Error('To nie Twój ruch.');
    try { this._apply(g, uci); } catch { throw new Error('Ruch niedozwolony.'); }
    this._emit(g);
    if (g.status === 'started') this._scheduleBot(g);
  }
  async resign(id) {
    const g = this.games.get(id); if (!g) return;
    g.status = 'resign'; g.winner = g.myColor === 'white' ? 'black' : 'white';
    this._emit(g);
  }
  async abort(id) {
    const g = this.games.get(id); if (!g) return;
    g.status = 'aborted'; this._emit(g);
  }
  async draw(id, yes) {
    const g = this.games.get(id); if (!g || !yes) return;
    // komputer demo przyjmuje remis, gdy materiał jest równy
    let bal = 0;
    for (const row of g.chess.board()) for (const sq of row) if (sq) bal += (sq.color === 'w' ? 1 : -1) * VALUE[sq.type];
    if (Math.abs(bal) <= 1 && g.uci.length > 20) { g.status = 'draw'; this._emit(g); }
    else {
      if (g.myColor === 'white') g.wdraw = true; else g.bdraw = true;
      this._emit(g);
      setTimeout(() => { g.wdraw = false; g.bdraw = false; if (g.status === 'started') this._emit(g); }, 1500);
    }
  }
  async claimVictory() {}
  async claimDraw() {}
  gameUrl() { return null; }
  tokenCreateUrl() { return null; }
}

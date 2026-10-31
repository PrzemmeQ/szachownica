// „Moje zapisane gry” — część poczekalni ogólnej (konta). Partie z klubów, poczekalni i Lichess
// zapisuje aplikacja po partii (albo przy pierwszym zapisanym momencie); momenty to pozycje (numer półruchu)
// z notatką gracza albo uwagą trenera. Obrazy szachownicy rysuje przeglądarka — serwer trzyma tylko ruchy.

const MAX_GAMES = 500; // najstarsze ponad limit są usuwane
const MAX_MOMENTS = 50; // na partię
const NOTE_MAX = 500;
const SOURCES = new Set(['club', 'public', 'lichess']);

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanNote = (s) => String(s ?? '').trim().slice(0, NOTE_MAX);

export const archiveMethods = {
  migrateArchive() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS saved_games (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, room_name TEXT,
        white TEXT, black TEXT, my_color TEXT, result TEXT, status TEXT, label TEXT, moves TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS saved_games_ref ON saved_games (account_id, source, ref);
      CREATE TABLE IF NOT EXISTS moments (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL, account_id TEXT NOT NULL, ply INTEGER NOT NULL, note TEXT,
        kind TEXT NOT NULL, author_id TEXT, author_nick TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS moments_game ON moments (game_id);
    `);
  },
  async archiveAccount(token) {
    const a = await this.acctVerify(token);
    if (!a) this.fail('Zapisane gry wymagają konta — zaloguj się ponownie.');
    return a;
  },
  // Zapis albo aktualizacja partii w archiwum konta (po partii albo przy zapisie momentu).
  archiveUpsert(accountId, g, myColor) {
    const source = String(g?.source || '');
    const ref = clean(g?.ref, 60);
    if (!SOURCES.has(source) || !ref) this.fail('Nie udało się zapisać partii.');
    const moves = (Array.isArray(g.moves) ? g.moves : []).slice(0, 600).filter((u) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)).join(' ');
    const now = Date.now();
    const old = this.sql.exec('SELECT * FROM saved_games WHERE account_id = ? AND source = ? AND ref = ?', accountId, source, ref).toArray()[0];
    const v = [clean(g.roomName, 60), clean(g.white, 40), clean(g.black, 40), myColor === 'black' ? 'black' : 'white',
      clean(g.result, 8) || '*', clean(g.status, 20), clean(g.label, 40)];
    if (old) {
      // ruchy tylko dopisujemy (zapis w trakcie partii nie skraca pełnej partii)
      const keep = old.moves.split(' ').filter(Boolean).length > moves.split(' ').filter(Boolean).length ? old.moves : moves;
      this.sql.exec('UPDATE saved_games SET room_name = ?, white = ?, black = ?, my_color = ?, result = ?, status = ?, label = ?, moves = ?, updated_at = ? WHERE id = ?',
        ...v, keep, now, old.id);
      return old.id;
    }
    const id = this.randomCode(12);
    this.sql.exec('INSERT INTO saved_games (id, account_id, source, ref, room_name, white, black, my_color, result, status, label, moves, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, accountId, source, ref, ...v, moves, now, now);
    // limit: usuń najstarsze partie (z momentami)
    const extra = this.sql.exec('SELECT id FROM saved_games WHERE account_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?', accountId, MAX_GAMES).toArray();
    for (const x of extra) { this.sql.exec('DELETE FROM moments WHERE game_id = ?', x.id); this.sql.exec('DELETE FROM saved_games WHERE id = ?', x.id); }
    return id;
  },
  addMoment(gameId, accountId, ply, note, kind, author) {
    const n = this.sql.exec('SELECT COUNT(*) AS c FROM moments WHERE game_id = ?', gameId).one().c;
    if (n >= MAX_MOMENTS) this.fail(`Przy jednej partii można zapisać najwyżej ${MAX_MOMENTS} momentów.`);
    const id = this.randomCode(12);
    this.sql.exec('INSERT INTO moments (id, game_id, account_id, ply, note, kind, author_id, author_nick, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, gameId, accountId, Math.max(0, Math.min(600, Number(ply) | 0)), cleanNote(note), kind, author?.id || null, author?.nick || null, Date.now());
    return id;
  },
  momentOf(accountId, id) {
    const m = this.sql.exec('SELECT * FROM moments WHERE id = ? AND account_id = ?', String(id || ''), accountId).toArray()[0];
    if (!m) this.fail('Nie ma takiego momentu.');
    return m;
  },
  gameView(row) {
    return {
      id: row.id, source: row.source, ref: row.ref, roomName: row.room_name, white: row.white, black: row.black, myColor: row.my_color,
      result: row.result, status: row.status, label: row.label, moves: row.moves ? row.moves.split(' ') : [], createdAt: row.created_at, updatedAt: row.updated_at,
    };
  },

  // --- HTTP (konto) ---
  async archiveAction(action, body) {
    const a = await this.archiveAccount(body.accountToken);
    switch (action) {
      case 'games-save': return { id: this.archiveUpsert(a.id, body.game, body.game?.myColor) };
      case 'moment-add': {
        const gameId = this.archiveUpsert(a.id, body.game, body.game?.myColor);
        return { id: this.addMoment(gameId, a.id, body.ply, body.note, 'self', null), gameId };
      }
      case 'moment-note': {
        const m = this.momentOf(a.id, body.id);
        if (m.kind !== 'self') this.fail('Uwagi trenera nie można zmienić.');
        this.sql.exec('UPDATE moments SET note = ? WHERE id = ?', cleanNote(body.note), m.id);
        return {};
      }
      case 'moment-delete': { const m = this.momentOf(a.id, body.id); this.sql.exec('DELETE FROM moments WHERE id = ?', m.id); return {}; }
      case 'games-list': {
        const rows = this.sql.exec(`SELECT g.*, (SELECT COUNT(*) FROM moments m WHERE m.game_id = g.id) AS n,
          (SELECT COUNT(*) FROM moments m WHERE m.game_id = g.id AND m.kind = 'coach') AS coach
          FROM saved_games g WHERE g.account_id = ? ORDER BY g.updated_at DESC LIMIT 200`, a.id).toArray();
        return { games: rows.map((r) => ({ ...this.gameView(r), moves: undefined, plies: r.moves ? r.moves.split(' ').length : 0, moments: r.n, coachNotes: r.coach })) };
      }
      case 'game-get': {
        const g = this.sql.exec('SELECT * FROM saved_games WHERE id = ? AND account_id = ?', String(body.id || ''), a.id).toArray()[0];
        if (!g) this.fail('Nie ma takiej partii.');
        const moments = this.sql.exec('SELECT * FROM moments WHERE game_id = ? ORDER BY ply, created_at', g.id).toArray()
          .map((m) => ({ id: m.id, ply: m.ply, note: m.note || '', kind: m.kind, author: m.author_nick || null, createdAt: m.created_at }));
        return { game: this.gameView(g), moments };
      }
      case 'game-delete': {
        const g = this.sql.exec('SELECT id FROM saved_games WHERE id = ? AND account_id = ?', String(body.id || ''), a.id).toArray()[0];
        if (g) { this.sql.exec('DELETE FROM moments WHERE game_id = ?', g.id); this.sql.exec('DELETE FROM saved_games WHERE id = ?', g.id); }
        return {};
      }
      default: this.fail('Nie znaleziono.');
    }
    return {};
  },

  // Uwaga trenera (wewnętrzne, z klubu): trafia do archiwów wybranych graczy, z powiadomieniem.
  acctCoachNote(body) {
    let n = 0;
    for (const t of body.targets || []) {
      if (!this.member(String(t.accountId || ''))) continue;
      const gameId = this.archiveUpsert(String(t.accountId), body.game, t.myColor);
      this.addMoment(gameId, String(t.accountId), body.ply, body.note, 'coach', body.author);
      this.toMember(String(t.accountId), { t: 'event', ev: { type: 'coachNote', author: body.author?.nick || '', opponent: t.myColor === 'white' ? body.game.black : body.game.white } });
      n++;
    }
    return { saved: n };
  },
  deleteArchive(accountId) {
    for (const g of this.sql.exec('SELECT id FROM saved_games WHERE account_id = ?', accountId).toArray()) this.sql.exec('DELETE FROM moments WHERE game_id = ?', g.id);
    this.sql.exec('DELETE FROM saved_games WHERE account_id = ?', accountId);
    // uwagi, które ta osoba zostawiła jako trener, zostają u uczniów bez danych autora
    this.sql.exec("UPDATE moments SET author_id = NULL, author_nick = 'usunięty gracz' WHERE author_id = ?", accountId);
  },
};

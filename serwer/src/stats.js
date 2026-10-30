// Statystyki do oceny pomysłu (handoff, sekcja 6): mierzymy zachowanie, nie deklaracje.
// Zbiera je poczekalnia ogólna. Bez danych osobowych: dzienne liczniki i aktywność graczy
// jako para (kod pokoju, id gracza w pokoju) — bez nicków, e-maili i adresów.

const DAY = 86400000;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export const statsMethods = {
  // ev: { kind: 'room' | 'account' | 'game_start' | 'game' | 'game_aborted', room?, roomName?, players? }
  statRecord(ev) {
    const kind = String(ev.kind || '');
    if (!/^[a-z_]{1,20}$/.test(kind)) return;
    const d = day();
    this.sql.exec(`INSERT INTO stat_days (day, kind, n) VALUES (?, ?, 1)
      ON CONFLICT (day, kind) DO UPDATE SET n = n + 1`, d, kind);
    if (kind === 'game' && Array.isArray(ev.players)) {
      const room = String(ev.room || '').slice(0, 20);
      for (const p of ev.players.slice(0, 2)) {
        this.sql.exec(`INSERT INTO stat_players (room, member, day, games) VALUES (?, ?, ?, 1)
          ON CONFLICT (room, member, day) DO UPDATE SET games = games + 1`, room, String(p).slice(0, 20), d);
      }
      if (ev.roomName) this.kv('stat_room_' + room, String(ev.roomName).slice(0, 40));
    }
  },

  // Klucz ustawia właściciel (wrangler secret STATS_KEY). Błędne próby liczą się do limitu.
  async statsAuth(given, ip) {
    const want = this.env.STATS_KEY;
    if (!want) return { status: 503, msg: 'Statystyki nie są skonfigurowane (brak STATS_KEY na serwerze).' };
    const [a, b] = await Promise.all([this.sha256(String(given || '')), this.sha256(want)]);
    if (a === b) return null;
    const limited = await this.takeLimit('statsfail', ip);
    return { status: limited ? 429 : 401, msg: limited ? 'Za dużo błędnych prób. Spróbuj za godzinę.' : 'Zły klucz.' };
  },

  statsSummary() {
    const now = Date.now();
    const d30 = day(now - 29 * DAY);
    const d28 = day(now - 27 * DAY);
    const d7 = day(now - 6 * DAY);
    const kinds = ['game', 'game_start', 'game_aborted', 'room', 'account'];

    const totals = {};
    for (const k of kinds) totals[k] = this.sql.exec('SELECT COALESCE(SUM(n), 0) AS n FROM stat_days WHERE kind = ?', k).one().n;
    totals.accountsWithPassword = this.sql.exec('SELECT COUNT(*) AS c FROM members WHERE pass_hash IS NOT NULL').one().c;

    const days = [];
    for (let i = 29; i >= 0; i--) {
      const dd = day(now - i * DAY);
      const row = { day: dd };
      for (const k of kinds) row[k] = 0;
      days.push(row);
    }
    const byDay = new Map(days.map((r) => [r.day, r]));
    for (const r of this.sql.exec('SELECT day, kind, n FROM stat_days WHERE day >= ?', d30).toArray()) {
      if (byDay.has(r.day) && r.kind in byDay.get(r.day)) byDay.get(r.day)[r.kind] = r.n;
    }
    for (const r of this.sql.exec('SELECT day, COUNT(*) AS c FROM stat_players WHERE day >= ? GROUP BY day', d30).toArray()) {
      if (byDay.has(r.day)) byDay.get(r.day).players = r.c;
    }

    const distinct = (from) => this.sql.exec(
      'SELECT COUNT(*) AS c FROM (SELECT DISTINCT room, member FROM stat_players WHERE day >= ?)', from).one().c;

    // stali gracze: co najmniej 3 partie w ostatnich 28 dniach
    const regulars = this.sql.exec(`SELECT room, member, SUM(games) AS g FROM stat_players WHERE day >= ?
      GROUP BY room, member HAVING g >= 3`, d28).toArray();
    // wracający: grali w ostatnim tygodniu i wcześniej (8–28 dni temu)
    const returning = this.sql.exec(`SELECT COUNT(*) AS c FROM (
      SELECT room, member FROM stat_players WHERE day >= ? GROUP BY room, member
      INTERSECT SELECT room, member FROM stat_players WHERE day >= ? AND day < ? GROUP BY room, member)`, d7, d28, d7).one().c;

    // grupy: pokoje z co najmniej 4 stałymi graczami (próg sukcesu z handoffu)
    const perRoom = new Map();
    for (const r of regulars) perRoom.set(r.room, (perRoom.get(r.room) || 0) + 1);
    const rooms = this.sql.exec(`SELECT room, COUNT(DISTINCT member) AS players, SUM(games) AS games, MAX(day) AS last
      FROM stat_players WHERE day >= ? GROUP BY room ORDER BY games DESC LIMIT 30`, d30).toArray().map((r) => ({
      room: r.room === 'publiczny' ? 'Poczekalnia ogólna' : (this.kv('stat_room_' + r.room) || 'pokój'),
      public: r.room === 'publiczny',
      players: r.players,
      gameSlots: r.games, // partie liczone na gracza (każda partia = 2)
      regulars: perRoom.get(r.room) || 0,
      last: r.last,
    }));
    const groups = rooms.filter((r) => !r.public && r.regulars >= 4).length;

    return {
      generatedAt: new Date(now).toISOString(),
      totals,
      active: { last7: distinct(d7), last30: distinct(d30) },
      regulars28: regulars.length,
      returning,
      groups,
      successThreshold: groups >= 1,
      rooms,
      days,
    };
  },
};

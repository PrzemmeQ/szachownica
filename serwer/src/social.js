// Znajomi (konta, poczekalnia ogólna): zaproszenie i akceptacja, blokowanie, ostatni rywale.
// Obecność („w aplikacji”) widzą tylko znajomi i ostatni rywale — nie ma listy wszystkich graczy online.

const INVITES_PER_DAY = 20;

export const socialMethods = {
  pairKey(a, b) { return a < b ? [a, b] : [b, a]; },
  isFriend(a, b) {
    const [x, y] = this.pairKey(a, b);
    return this.sql.exec('SELECT 1 FROM friends WHERE a = ? AND b = ?', x, y).toArray().length > 0;
  },
  isBlocked(a, b) { // którakolwiek strona zablokowała drugą
    return this.sql.exec('SELECT 1 FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)', a, b, b, a).toArray().length > 0;
  },
  friendIds(me) {
    return this.sql.exec('SELECT a, b FROM friends WHERE a = ? OR b = ?', me, me).toArray().map((r) => (r.a === me ? r.b : r.a));
  },
  recentOpponents(me, limit = 20) {
    const seen = new Map();
    for (const g of this.sql.exec('SELECT white_id, black_id, created_at FROM games WHERE white_id = ? OR black_id = ? ORDER BY created_at DESC LIMIT 200', me, me).toArray()) {
      const opp = g.white_id === me ? g.black_id : g.white_id;
      if (!seen.has(opp)) seen.set(opp, g.created_at);
      if (seen.size >= limit) break;
    }
    return seen;
  },
  personOf(id, online) {
    const m = this.member(id);
    if (!m) return null;
    const r = this.ratingFor(id, 'rapid');
    return { id, nick: m.nick, online: online.has(id), rating: r ? Math.round(r.rating) : null };
  },
  socialOf(me) {
    const online = this.onlineIds();
    const friends = this.friendIds(me).map((id) => this.personOf(id, online)).filter(Boolean)
      .sort((x, y) => (y.online - x.online) || x.nick.localeCompare(y.nick, 'pl'));
    const fset = new Set(friends.map((f) => f.id));
    const recent = [...this.recentOpponents(me)].filter(([id]) => !fset.has(id) && !this.isBlocked(me, id))
      .map(([id, at]) => ({ ...this.personOf(id, online), lastAt: at })).filter((p) => p.id);
    const incoming = this.sql.exec('SELECT from_id FROM friend_invites WHERE to_id = ?', me).toArray()
      .map((r) => this.personOf(r.from_id, new Set())).filter(Boolean);
    const outgoing = this.sql.exec('SELECT to_id FROM friend_invites WHERE from_id = ?', me).toArray()
      .map((r) => this.personOf(r.to_id, new Set())).filter(Boolean);
    const blocked = this.sql.exec('SELECT blocked FROM blocks WHERE blocker = ?', me).toArray()
      .map((r) => this.personOf(r.blocked, new Set())).filter(Boolean);
    return { friends, recent, incoming, outgoing, blocked };
  },
  // Kogo powiadomić o zmianie obecności danego gracza: znajomi i ostatni rywale.
  presenceAudience(id) {
    return new Set([...this.friendIds(id), ...this.recentOpponents(id).keys()]);
  },
  notifySocial(id) { this.toMember(id, { t: 'social', social: this.socialOf(id) }); },

  cmdFriendInvite(me, msg) {
    let target = msg.id ? this.member(String(msg.id)) : null;
    if (!target && msg.nick) target = this.sql.exec('SELECT * FROM members WHERE nick_key = ?', this.nickKey(msg.nick)).toArray()[0];
    if (!target) this.fail('Nie ma gracza o takim nicku.');
    if (target.id === me) this.fail('To Ty.');
    if (this.isFriend(me, target.id)) this.fail('Już jesteście znajomymi.');
    // zablokowany nie dowie się o blokadzie: zaproszenie „wysyła się”, ale nigdzie nie trafia
    if (this.isBlocked(me, target.id)) return { sent: true };
    const day = Date.now() - 86400000;
    this.sql.exec('DELETE FROM invite_log WHERE at < ?', day);
    if (this.sql.exec('SELECT COUNT(*) AS c FROM invite_log WHERE from_id = ?', me).one().c >= INVITES_PER_DAY) {
      this.fail(`Możesz wysłać najwyżej ${INVITES_PER_DAY} zaproszeń dziennie.`);
    }
    // ta osoba już zaprosiła mnie — od razu jesteśmy znajomymi
    if (this.sql.exec('SELECT 1 FROM friend_invites WHERE from_id = ? AND to_id = ?', target.id, me).toArray().length) {
      return this.cmdFriendAccept(me, target.id);
    }
    this.sql.exec('INSERT OR IGNORE INTO friend_invites (from_id, to_id, created_at) VALUES (?, ?, ?)', me, target.id, Date.now());
    this.sql.exec('INSERT INTO invite_log (from_id, at) VALUES (?, ?)', me, Date.now());
    this.toMember(target.id, { t: 'event', ev: { type: 'friendInvite', from: this.member(me).nick } });
    this.notifySocial(target.id);
    return { sent: true, social: this.socialOf(me) };
  },
  cmdFriendAccept(me, fromId) {
    const from = String(fromId || '');
    if (!this.sql.exec('SELECT 1 FROM friend_invites WHERE from_id = ? AND to_id = ?', from, me).toArray().length) this.fail('To zaproszenie jest już nieaktualne.');
    this.sql.exec('DELETE FROM friend_invites WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', from, me, me, from);
    const [a, b] = this.pairKey(me, from);
    this.sql.exec('INSERT OR IGNORE INTO friends (a, b, since) VALUES (?, ?, ?)', a, b, Date.now());
    this.notifySocial(from);
    return { social: this.socialOf(me) };
  },
  cmdFriendDecline(me, fromId) { // po cichu: zapraszający widzi tylko, że zaproszenie zniknęło
    this.sql.exec('DELETE FROM friend_invites WHERE from_id = ? AND to_id = ?', String(fromId || ''), me);
    this.notifySocial(String(fromId || ''));
    return { social: this.socialOf(me) };
  },
  cmdFriendCancel(me, toId) {
    this.sql.exec('DELETE FROM friend_invites WHERE from_id = ? AND to_id = ?', me, String(toId || ''));
    this.notifySocial(String(toId || ''));
    return { social: this.socialOf(me) };
  },
  // Zaproszenie linkiem (WhatsApp, SMS…): jednorazowe, ważne 7 dni. Kto je otworzy, od razu zostaje znajomym.
  async cmdFriendLinkCreate(me) {
    const day = Date.now() - 86400000;
    this.sql.exec('DELETE FROM invite_log WHERE at < ?', day);
    if (this.sql.exec('SELECT COUNT(*) AS c FROM invite_log WHERE from_id = ?', me).one().c >= INVITES_PER_DAY) {
      this.fail(`Możesz wysłać najwyżej ${INVITES_PER_DAY} zaproszeń dziennie.`);
    }
    this.sql.exec('CREATE TABLE IF NOT EXISTS friend_links (hash TEXT PRIMARY KEY, from_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('DELETE FROM friend_links WHERE expires_at < ?', Date.now());
    const token = this.randomCode(20);
    this.sql.exec('INSERT INTO friend_links (hash, from_id, expires_at) VALUES (?, ?, ?)', await this.sha256(token), me, Date.now() + 7 * 86400000);
    this.sql.exec('INSERT INTO invite_log (from_id, at) VALUES (?, ?)', me, Date.now());
    return { token };
  },
  async friendLinkRow(token) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS friend_links (hash TEXT PRIMARY KEY, from_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    const row = this.sql.exec('SELECT * FROM friend_links WHERE hash = ? AND expires_at > ?', await this.sha256(String(token || '')), Date.now()).toArray()[0];
    const from = row && this.member(row.from_id);
    if (!row || !from || from.removed) this.fail('Ten link do znajomych jest nieaktualny — został już użyty albo wygasł.');
    return { row, from };
  },
  async cmdFriendLinkInfo(me, token) {
    const { from } = await this.friendLinkRow(token);
    return { nick: from.nick, self: from.id === me, already: this.isFriend(me, from.id) };
  },
  async cmdFriendLinkUse(me, token) {
    const { row, from } = await this.friendLinkRow(token);
    if (from.id === me) this.fail('To Twój własny link — wyślij go znajomemu.');
    this.sql.exec('DELETE FROM friend_links WHERE hash = ?', row.hash);
    // zablokowana osoba: po cichu nic się nie dzieje
    if (this.isBlocked(me, from.id)) return { nick: from.nick, social: this.socialOf(me) };
    const [a, b] = this.pairKey(me, from.id);
    this.sql.exec('INSERT OR IGNORE INTO friends (a, b, since) VALUES (?, ?, ?)', a, b, Date.now());
    this.sql.exec('DELETE FROM friend_invites WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', me, from.id, from.id, me);
    this.toMember(from.id, { t: 'event', ev: { type: 'friendJoined', nick: this.member(me).nick } });
    this.notifySocial(from.id);
    return { nick: from.nick, social: this.socialOf(me) };
  },
  cmdFriendRemove(me, otherId) {
    const [a, b] = this.pairKey(me, String(otherId || ''));
    this.sql.exec('DELETE FROM friends WHERE a = ? AND b = ?', a, b);
    this.notifySocial(String(otherId || ''));
    return { social: this.socialOf(me) };
  },
  cmdBlock(me, otherId) {
    const id = String(otherId || '');
    if (!this.member(id) || id === me) this.fail('Nie ma takiego gracza.');
    this.sql.exec('INSERT OR IGNORE INTO blocks (blocker, blocked, since) VALUES (?, ?, ?)', me, id, Date.now());
    const [a, b] = this.pairKey(me, id);
    this.sql.exec('DELETE FROM friends WHERE a = ? AND b = ?', a, b);
    this.sql.exec('DELETE FROM friend_invites WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', me, id, id, me);
    for (const ch of this.sql.exec('SELECT * FROM challenges WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', me, id, id, me).toArray()) {
      this.endChallenge(ch, 'declined');
    }
    this.notifySocial(id);
    return { social: this.socialOf(me) };
  },
  cmdUnblock(me, otherId) {
    this.sql.exec('DELETE FROM blocks WHERE blocker = ? AND blocked = ?', me, String(otherId || ''));
    return { social: this.socialOf(me) };
  },
};

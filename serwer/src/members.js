// Członkostwo w klubie: zatwierdzanie próśb o dołączenie, blokady, zaproszenia po nicku.
// Do klubu dołącza się zawsze kontem. Przy włączonym zatwierdzaniu (domyślnie w nowym klubie)
// kod i hasło klubu pozwalają tylko poprosić — wpuszcza założyciel albo administrator.

const REQUEST_TTL = 7 * 86400000; // prośba czeka 7 dni
const MAX_PENDING = 30; // najwyżej 30 oczekujących próśb na klub
const MAX_REJECTS = 2; // po 2 odrzuceniach kolejne prośby są zablokowane

export const memberMethods = {
  migrateMembers() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS join_requests (account_id TEXT PRIMARY KEY, nick TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS join_rejects (account_id TEXT PRIMARY KEY, nick TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS club_invites (account_id TEXT PRIMARY KEY, nick TEXT NOT NULL, by_id TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    try { this.sql.exec('ALTER TABLE banned_accounts ADD COLUMN nick TEXT'); } catch {}
    try { this.sql.exec("ALTER TABLE account_rooms ADD COLUMN status TEXT NOT NULL DEFAULT 'member'"); } catch {}
  },
  approvalOn() { return this.kv('approve') === '1'; },

  // Wolny nick w klubie: nick konta, a gdy zajęty — z cyfrą na końcu.
  freeNick(nick) {
    const base = String(nick).slice(0, 18);
    let n = base;
    for (let i = 2; this.sql.exec('SELECT 1 FROM members WHERE nick_key = ?', this.nickKey(n)).toArray().length; i++) n = base + i;
    return n;
  },
  memberJson(m, token) { return { name: this.kv('name'), code: this.kv('code'), memberId: m.id ?? m.memberId, nick: m.nick, token }; },

  purgeRequests() {
    const old = this.sql.exec('SELECT account_id FROM join_requests WHERE at < ?', Date.now() - REQUEST_TTL).toArray();
    if (!old.length) return;
    this.sql.exec('DELETE FROM join_requests WHERE at < ?', Date.now() - REQUEST_TTL);
    for (const r of old) this.tellAccount(r.account_id, null, 'expired');
  },
  // Status klubu w „Moich klubach” konta (poczekalnia) + powiadomienie, jeśli jest online.
  tellAccount(accountId, status, event) {
    const p = this.callPublic('acct-room-status', { accountId, roomId: this.kv('room_id'), name: this.kv('name'), status, event }).catch(() => null);
    this.ctx.waitUntil?.(p);
    return p;
  },
  requestsList() {
    this.purgeRequests();
    return this.sql.exec('SELECT account_id AS id, nick, at FROM join_requests ORDER BY at').toArray().map((r) => ({
      ...r, wasRemoved: !!this.sql.exec('SELECT 1 FROM banned_accounts WHERE account_id = ?', r.id).toArray().length,
      rejected: this.sql.exec('SELECT n FROM join_rejects WHERE account_id = ?', r.id).toArray()[0]?.n || 0,
    }));
  },
  blockedList() {
    const out = this.sql.exec('SELECT account_id AS id, nick, at FROM banned_accounts ORDER BY at DESC').toArray()
      .map((b) => ({ id: b.id, nick: b.nick || this.sql.exec('SELECT nick FROM members WHERE account_id = ? ORDER BY joined_at DESC', b.id).toArray()[0]?.nick || '?', reason: 'removed', at: b.at }));
    for (const r of this.sql.exec('SELECT * FROM join_rejects WHERE n >= ? ORDER BY at DESC', MAX_REJECTS).toArray()) {
      if (!out.some((b) => b.id === r.account_id)) out.push({ id: r.account_id, nick: r.nick, reason: 'rejected', at: r.at });
    }
    return out;
  },
  invitesList() { return this.sql.exec('SELECT account_id AS id, nick, at FROM club_invites ORDER BY at DESC').toArray(); },
  // Założyciel i admini dostają na bieżąco liczbę próśb (karta w lobby, odznaka).
  notifyManagers() {
    const online = this.onlineIds();
    for (const m of this.activeMembers()) {
      if ((m.role === 'owner' || m.role === 'admin') && online.has(m.id)) this.toMember(m.id, { t: 'roomInfo', room: this.roomInfo(m.id) });
    }
  },

  // Dołączenie kodem (wywołuje poczekalnia po sprawdzeniu kodu i blokady). Zwraca członkostwo albo { pending }.
  async joinWithAccount(accountId, accountNick, wantedNick) {
    if (this.sql.exec('SELECT 1 FROM banned_accounts WHERE account_id = ?', accountId).toArray().length) {
      this.fail('Zostałeś usunięty z tego klubu. Wrócić możesz tylko, jeśli założyciel albo administrator Cię odblokuje.');
    }
    const had = this.sql.exec('SELECT * FROM members WHERE account_id = ? AND removed = 0', accountId).toArray()[0];
    if (had) return this.memberJson(had, await this.issueToken(had.id));
    if (this.sql.exec('SELECT 1 FROM club_invites WHERE account_id = ?', accountId).toArray().length) return this.acceptInvite(accountId, accountNick);
    // wraca ktoś, kto sam wyszedł: to samo miejsce w klubie (historia partii), jeśli nick jest wolny
    const left = this.sql.exec('SELECT * FROM members WHERE account_id = ? AND removed = 1 ORDER BY joined_at DESC', accountId).toArray()[0];
    if (left && !this.approvalOn() && !this.sql.exec('SELECT 1 FROM members WHERE nick_key = ?', this.nickKey(left.nick)).toArray().length) {
      this.sql.exec('UPDATE members SET removed = 0, nick_key = ? WHERE id = ?', this.nickKey(left.nick), left.id);
      this.broadcastMembers();
      return this.memberJson(left, await this.issueToken(left.id));
    }
    const nick = String(wantedNick || accountNick || '').trim();
    this.checkNewNick(nick);
    if (this.sql.exec('SELECT 1 FROM members WHERE nick_key = ?', this.nickKey(nick)).toArray().length) this.fail('Ten nick jest już zajęty w klubie.');
    if (!this.approvalOn()) {
      const m = await this.addMember(nick, 'member', accountId);
      await this.refreshRatings(true);
      this.broadcastMembers();
      return { ...this.memberJson(m, m.token) };
    }
    const rej = this.sql.exec('SELECT n FROM join_rejects WHERE account_id = ?', accountId).toArray()[0]?.n || 0;
    if (rej >= MAX_REJECTS) this.fail('Twoje prośby do tego klubu zostały odrzucone. Kolejnej nie można wysłać — chyba że założyciel albo administrator Cię odblokuje.');
    this.purgeRequests();
    if (!this.sql.exec('SELECT 1 FROM join_requests WHERE account_id = ?', accountId).toArray().length) {
      const n = this.sql.exec('SELECT COUNT(*) AS c FROM join_requests').one().c;
      if (n >= MAX_PENDING) this.fail('Ten klub ma teraz za dużo oczekujących próśb. Spróbuj za kilka dni.');
      this.sql.exec('INSERT INTO join_requests (account_id, nick, at) VALUES (?, ?, ?)', accountId, nick, Date.now());
      this.notifyManagers();
    }
    return { pending: true, name: this.kv('name'), code: this.kv('code') };
  },
  async acceptInvite(accountId, accountNick) {
    const inv = this.sql.exec('SELECT * FROM club_invites WHERE account_id = ?', accountId).toArray()[0];
    this.sql.exec('DELETE FROM club_invites WHERE account_id = ?', accountId);
    this.sql.exec('DELETE FROM join_requests WHERE account_id = ?', accountId);
    const m = await this.addMember(this.freeNick(accountNick || inv?.nick || 'Gracz'), 'member', accountId);
    await this.refreshRatings(true);
    this.broadcastMembers();
    this.notifyManagers();
    await this.tellAccount(accountId, 'member', null);
    return this.memberJson(m, m.token);
  },

  // Polecenia założyciela i administratorów.
  async cmdApprove(me, id) {
    this.needManager(me);
    const r = this.sql.exec('SELECT * FROM join_requests WHERE account_id = ?', String(id || '')).toArray()[0];
    if (!r) this.fail('Ta prośba jest już nieaktualna.');
    this.sql.exec('DELETE FROM join_requests WHERE account_id = ?', r.account_id);
    this.sql.exec('DELETE FROM join_rejects WHERE account_id = ?', r.account_id);
    this.sql.exec('DELETE FROM banned_accounts WHERE account_id = ?', r.account_id);
    await this.addMember(this.freeNick(r.nick), 'member', r.account_id);
    await this.refreshRatings(true);
    this.broadcastMembers();
    this.notifyManagers();
    await this.tellAccount(r.account_id, 'member', 'approved');
    return { requests: this.requestsList() };
  },
  async cmdReject(me, id) {
    this.needManager(me);
    const r = this.sql.exec('SELECT * FROM join_requests WHERE account_id = ?', String(id || '')).toArray()[0];
    if (!r) this.fail('Ta prośba jest już nieaktualna.');
    this.sql.exec('DELETE FROM join_requests WHERE account_id = ?', r.account_id);
    this.sql.exec(`INSERT INTO join_rejects (account_id, nick, n, at) VALUES (?, ?, 1, ?)
      ON CONFLICT (account_id) DO UPDATE SET n = n + 1, nick = excluded.nick, at = excluded.at`, r.account_id, r.nick, Date.now());
    this.notifyManagers();
    await this.tellAccount(r.account_id, null, 'rejected');
    return { requests: this.requestsList(), blocked: this.blockedList() };
  },
  cmdUnblockMember(me, id) {
    this.needManager(me);
    const aid = String(id || '');
    this.sql.exec('DELETE FROM banned_accounts WHERE account_id = ?', aid);
    this.sql.exec('DELETE FROM join_rejects WHERE account_id = ?', aid);
    return { blocked: this.blockedList() };
  },
  async cmdInviteNick(me, nick) {
    this.needManager(me);
    const acct = await this.callPublic('acct-find', { nick: String(nick || '') });
    if (!acct?.id) this.fail('Nie ma konta o takim nicku.');
    if (this.sql.exec('SELECT 1 FROM members WHERE account_id = ? AND removed = 0', acct.id).toArray().length) this.fail(`${acct.nick} jest już w klubie.`);
    // zaproszenie od założyciela/admina zdejmuje blokadę
    this.sql.exec('DELETE FROM banned_accounts WHERE account_id = ?', acct.id);
    this.sql.exec('DELETE FROM join_rejects WHERE account_id = ?', acct.id);
    this.sql.exec('DELETE FROM join_requests WHERE account_id = ?', acct.id);
    this.sql.exec('INSERT OR REPLACE INTO club_invites (account_id, nick, by_id, at) VALUES (?, ?, ?, ?)', acct.id, acct.nick, me, Date.now());
    this.notifyManagers();
    await this.tellAccount(acct.id, 'invited', 'invited');
    return { invites: this.invitesList(), nick: acct.nick };
  },
  async cmdCancelInvite(me, id) {
    this.needManager(me);
    const aid = String(id || '');
    if (this.sql.exec('SELECT 1 FROM club_invites WHERE account_id = ?', aid).toArray().length) {
      this.sql.exec('DELETE FROM club_invites WHERE account_id = ?', aid);
      await this.tellAccount(aid, null, null);
    }
    return { invites: this.invitesList() };
  },
  cmdSetApproval(me, on) {
    this.needOwner(me);
    this.kv('approve', on ? '1' : '0');
    this.notifyManagers();
    return { approve: this.approvalOn() };
  },

  // Wejście do klubu z „Moich klubów” (konto): członek, zaproszony albo czekający na zatwierdzenie.
  async accountEnter(account) {
    const m = this.sql.exec('SELECT * FROM members WHERE account_id = ? AND removed = 0', account.id).toArray()[0];
    if (m) return { status: 200, body: this.memberJson(m, await this.issueToken(m.id)) };
    if (this.sql.exec('SELECT 1 FROM club_invites WHERE account_id = ?', account.id).toArray().length) {
      return { status: 200, body: await this.acceptInvite(account.id, account.nick) };
    }
    this.purgeRequests();
    if (this.sql.exec('SELECT 1 FROM join_requests WHERE account_id = ?', account.id).toArray().length) {
      return { status: 409, body: { error: 'Czekasz na zatwierdzenie przez założyciela albo administratora klubu.', pending: true } };
    }
    await this.tellAccount(account.id, null, null); // nieaktualny wpis w „Moich klubach”
    return { status: 404, body: { error: 'Twoje konto nie należy do tego klubu.' } };
  },
};

// Usunięcie konta (RODO). Konto znika od razu: nick, hasło, e-mail, klucze dostępu, logowania, znajomi,
// blokady, ranking, kluby. Rozegrane partie zostają u rywali i w klubach z nickiem „usunięty gracz”.
// Założyciel decyduje o każdym swoim klubie: usunąć go całkiem albo przekazać wybranemu członkowi.
import { verifyPassword } from './accounts.js';

export const DELETED_NICK = 'usunięty gracz';

export const deleteMethods = {
  // Poczekalnia: kluby, w których konto jest założycielem (z listą członków do przekazania).
  async cmdOwnedClubs(me) {
    const out = [];
    for (const r of this.acctRooms(me)) {
      const info = await this.callRoom(r.room, 'owner-info', { accountId: me }).catch(() => null);
      if (info?.owner) out.push({ room: r.room, name: info.name, members: info.members });
    }
    return { clubs: out };
  },

  async cmdDeleteAccount(me, msg) {
    const m = this.member(me);
    if (!m?.pass_hash || !(await verifyPassword(String(msg.password || ''), m.pass_hash))) this.fail('Złe hasło — konto nie zostało usunięte.');
    const decisions = msg.decisions || {};
    const owned = (await this.cmdOwnedClubs(me)).clubs;
    for (const c of owned) {
      const d = decisions[c.room];
      if (d !== 'delete' && !c.members.some((x) => x.id === d)) this.fail(`Zdecyduj, co z klubem „${c.name}”: usunąć go albo przekazać komuś.`);
    }
    // kluby: przekazanie albo usunięcie, potem anonimizacja członkostwa
    for (const r of this.acctRooms(me)) {
      await this.callRoom(r.room, 'account-delete', { accountId: me, decision: decisions[r.room] || null }).catch((e) => console.error('delete', e));
    }
    this.anonymizeAccount(me);
    return { closeAfterReply: true };
  },
  anonymizeAccount(id) {
    const now = Date.now();
    for (const ch of this.sql.exec('SELECT * FROM challenges WHERE from_id = ? OR to_id = ?', id, id).toArray()) this.endChallenge(ch, 'canceled');
    const sqls = [
      ['DELETE FROM tokens WHERE member_id = ?', id], ['DELETE FROM passkeys WHERE account_id = ?', id],
      ['DELETE FROM friends WHERE a = ? OR b = ?', id, id], ['DELETE FROM friend_invites WHERE from_id = ? OR to_id = ?', id, id],
      ['DELETE FROM blocks WHERE blocker = ? OR blocked = ?', id, id], ['DELETE FROM invite_log WHERE from_id = ?', id],
      ['DELETE FROM ratings WHERE member_id = ?', id], ['DELETE FROM account_rooms WHERE member_id = ?', id],
      ['DELETE FROM qr_logins WHERE account_id = ?', id], ['DELETE FROM resets WHERE member_id = ?', id],
      ['DELETE FROM pair_days WHERE a = ? OR b = ?', id, id], ['DELETE FROM code_locks WHERE key = ?', 'a:' + id],
      ['DELETE FROM seeks WHERE member_id = ?', id],
    ];
    for (const [q, ...args] of sqls) this.sql.exec(q, ...args);
    try { this.sql.exec('DELETE FROM friend_links WHERE from_id = ?', id); } catch {}
    this.sql.exec(`UPDATE members SET nick = ?, nick_key = ?, removed = 1, pass_hash = NULL, email = NULL, email_key = NULL,
      last_seen = ?, offline_since = ? WHERE id = ?`, DELETED_NICK, 'deleted#' + id, now, now, id);
    for (const ws of this.openSockets()) {
      if (this.att(ws).memberId === id) { this.send(ws, { t: 'authFailed', message: 'Konto zostało usunięte.', deleted: true }); ws.serializeAttachment({ at: Date.now() }); }
    }
    this.broadcastSeeks();
  },

  // Klub (wewnętrzne): czy konto jest założycielem i komu można przekazać klub.
  ownerInfo(accountId) {
    const m = this.sql.exec('SELECT * FROM members WHERE account_id = ? AND removed = 0', accountId).toArray()[0];
    if (!m || m.role !== 'owner') return { owner: false };
    const members = this.activeMembers().filter((x) => x.id !== m.id && x.account_id)
      .map((x) => ({ id: x.id, nick: x.nick, role: x.role }))
      .sort((a, b) => a.nick.localeCompare(b.nick, 'pl'));
    return { owner: true, name: this.kv('name'), members };
  },
  async accountDelete(accountId, decision) {
    const aid = String(accountId || '');
    for (const t of ['join_requests', 'join_rejects', 'club_invites', 'banned_accounts']) this.sql.exec(`DELETE FROM ${t} WHERE account_id = ?`, aid);
    const m = this.sql.exec('SELECT * FROM members WHERE account_id = ? AND removed = 0', aid).toArray()[0];
    if (m?.role === 'owner') {
      if (decision === 'delete') { await this.deleteClub(); return; }
      const heir = this.member(String(decision || ''));
      if (!heir || heir.removed) return;
      this.sql.exec("UPDATE members SET role = 'owner' WHERE id = ?", heir.id);
      this.kv('owner_id', heir.id);
      this.toMember(heir.id, { t: 'roomInfo', room: this.roomInfo(heir.id) });
      this.toMember(heir.id, { t: 'event', ev: { type: 'clubStatus', name: this.kv('name'), event: 'owner' } });
    }
    // wszystkie wpisy tego konta w klubie (także dawne) → „usunięty gracz”
    for (const x of this.sql.exec('SELECT * FROM members WHERE account_id = ?', aid).toArray()) {
      if (!x.removed) {
        this.dropMember(x, false);
        for (const ws of this.openSockets()) {
          if (this.att(ws).memberId === x.id) { this.send(ws, { t: 'authFailed', message: 'Konto zostało usunięte.' }); try { ws.close(4001, 'deleted'); } catch {} }
        }
      }
      this.sql.exec('UPDATE members SET nick = ?, nick_key = ?, account_id = NULL, removed = 1, role = ? WHERE id = ?', DELETED_NICK, 'deleted#' + x.id, 'member', x.id);
      this.sql.exec('DELETE FROM ratings WHERE member_id = ?', aid);
    }
    this.broadcastMembers();
  },
  // Usunięcie całego klubu: członkowie dostają powiadomienie, kod znika z katalogu, dane klubu są kasowane.
  async deleteClub() {
    const roomId = this.kv('room_id');
    const name = this.kv('name');
    for (const x of this.activeMembers()) {
      if (x.account_id) await this.callPublic('acct-room-status', { accountId: x.account_id, roomId, name, status: null, event: 'deleted' }).catch(() => null);
    }
    for (const ws of this.openSockets()) { this.send(ws, { t: 'authFailed', message: `Klub „${name}” został usunięty.`, removed: true }); try { ws.close(4003, 'deleted'); } catch {} }
    await this.callPublic('acct-room-unregister', { roomId }).catch(() => null);
    await this.ctx.storage.deleteAll();
    this.migrate(); // puste tabele: kolejne zapytania dostaną „Nie ma takiego klubu”
  },
};

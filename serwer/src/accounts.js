// Konta graczy (nick + hasło, opcjonalnie e-mail). Przechowywane w poczekalni ogólnej:
// konto = członek poczekalni z hasłem. Prywatne pokoje sprawdzają konto, pytając poczekalnię (serwer–serwer).

const PBKDF2_MAX = 100000; // limit Workers dla PBKDF2
const RESET_TTL = 60 * 60000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}
export async function hashPassword(password, iterations = PBKDF2_MAX) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}
export async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export function checkPassword(p) {
  const s = String(p ?? '');
  if (s.length < 8) return 'Hasło musi mieć co najmniej 8 znaków.';
  if (s.length > 200) return 'Hasło jest za długie.';
  return null;
}
export function cleanEmail(e) {
  const s = String(e ?? '').trim();
  if (!s) return { email: null, key: null };
  if (!EMAIL_RE.test(s)) return { error: 'Sprawdź adres e-mail.' };
  return { email: s, key: s.toLowerCase() };
}

// Metody dodawane do klasy Room (this = obiekt pokoju). Wywoływane tylko w poczekalni ogólnej.
export const accountMethods = {
  pbkdf2Iterations() { return this.test ? 1000 : PBKDF2_MAX; },
  lockLimits() { return this.test ? { fails: 3, ms: 3000 } : { fails: 5, ms: 15 * 60000 }; },

  async setEmail(memberId, email) {
    const e = cleanEmail(email);
    if (e.error) this.fail(e.error);
    if (e.key && this.sql.exec('SELECT 1 FROM members WHERE email_key = ? AND id != ?', e.key, memberId).toArray().length) {
      this.fail('Ten adres e-mail jest już przypisany do innego konta.');
    }
    this.sql.exec('UPDATE members SET email = ?, email_key = ? WHERE id = ?', e.email, e.key, memberId);
  },

  async acctRegister(body) {
    const err = checkPassword(body.password);
    if (err) this.fail(err);
    const e = cleanEmail(body.email);
    if (e.error) this.fail(e.error);
    if (e.key && this.sql.exec('SELECT 1 FROM members WHERE email_key = ?', e.key).toArray().length) {
      this.fail('Ten adres e-mail jest już przypisany do innego konta.');
    }
    const m = await this.addMember(body.nick, 'member');
    this.sql.exec('UPDATE members SET pass_hash = ?, email = ?, email_key = ? WHERE id = ?',
      await hashPassword(String(body.password), this.pbkdf2Iterations()), e.email, e.key, m.memberId);
    return { name: this.kv('name'), ...m, rooms: [] };
  },

  async acctLogin(body) {
    const key = this.nickKey(body.nick);
    const now = Date.now();
    const lock = this.sql.exec('SELECT * FROM login_fails WHERE nick_key = ?', key).toArray()[0];
    if (lock && lock.until > now) {
      this.fail(`Za dużo nieudanych prób. Spróbuj za ${Math.ceil((lock.until - now) / 60000)} min.`);
    }
    const m = this.sql.exec('SELECT * FROM members WHERE nick_key = ?', key).toArray()[0];
    const ok = m && m.pass_hash && await verifyPassword(String(body.password ?? ''), m.pass_hash);
    if (!ok) {
      const L = this.lockLimits();
      const count = (lock && lock.until <= now && lock.count >= L.fails ? 0 : lock?.count || 0) + 1;
      this.sql.exec('INSERT OR REPLACE INTO login_fails (nick_key, count, until) VALUES (?, ?, ?)',
        key, count, count >= L.fails ? now + L.ms : 0);
      if (m && !m.pass_hash) this.fail('To konto nie ma jeszcze hasła — zabezpiecz je na urządzeniu, na którym grasz.');
      this.fail('Nieprawidłowy nick lub hasło.');
    }
    this.sql.exec('DELETE FROM login_fails WHERE nick_key = ?', key);
    const token = await this.issueToken(m.id);
    return { name: this.kv('name'), memberId: m.id, nick: m.nick, token, rooms: this.acctRooms(m.id) };
  },

  async acctVerify(token) {
    const row = this.sql.exec('SELECT member_id FROM tokens WHERE hash = ?', await this.sha256(String(token ?? ''))).toArray()[0];
    const m = row && this.member(row.member_id);
    return m ? { id: m.id, nick: m.nick } : null;
  },

  acctAddRoom(accountId, code, name) {
    if (!this.member(accountId)) return;
    this.sql.exec('INSERT OR REPLACE INTO account_rooms (member_id, code, name, joined_at) VALUES (?, ?, ?, ?)',
      accountId, code, name, Date.now());
  },
  acctRooms(accountId) {
    return this.sql.exec('SELECT code, name FROM account_rooms WHERE member_id = ? ORDER BY joined_at DESC', accountId).toArray();
  },

  accountInfo(memberId) {
    const m = this.member(memberId);
    return { hasPassword: !!m?.pass_hash, email: m?.email || null };
  },

  // Ustawienie lub zmiana hasła (i e-maila) przez zalogowane urządzenie.
  async acctSetPassword(me, msg) {
    const m = this.member(me);
    if (msg.password != null && msg.password !== '') {
      if (m.pass_hash && !(await verifyPassword(String(msg.oldPassword ?? ''), m.pass_hash))) this.fail('Obecne hasło jest nieprawidłowe.');
      const err = checkPassword(msg.password);
      if (err) this.fail(err);
      this.sql.exec('UPDATE members SET pass_hash = ? WHERE id = ?', await hashPassword(String(msg.password), this.pbkdf2Iterations()), me);
    } else if (!m.pass_hash) {
      this.fail('Wpisz hasło.');
    }
    if (msg.email !== undefined) await this.setEmail(me, msg.email);
    return this.accountInfo(me);
  },

  // Zawsze ta sama odpowiedź (nie zdradzamy, czy konto istnieje).
  async acctResetRequest(body) {
    const login = String(body.login ?? '').trim();
    const mailEnabled = !!(this.env.RESEND_API_KEY && this.env.MAIL_FROM);
    const m = this.sql.exec('SELECT * FROM members WHERE nick_key = ? OR email_key = ?', this.nickKey(login), login.toLowerCase()).toArray()[0];
    const out = { ok: true, mailEnabled };
    if (!m || !m.email) return out;
    const token = this.randomCode(24);
    this.sql.exec('DELETE FROM resets WHERE member_id = ? OR expires_at < ?', m.id, Date.now());
    this.sql.exec('INSERT INTO resets (hash, member_id, expires_at) VALUES (?, ?, ?)', await this.sha256(token), m.id, Date.now() + RESET_TTL);
    const link = `${this.env.APP_URL || 'https://przemmeq.github.io/szachownica/przy-szachownicy/'}?reset=${token}`;
    if (this.test) out.debugToken = token;
    if (mailEnabled) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: this.env.MAIL_FROM, to: [m.email], subject: 'Przy Szachownicy — nowe hasło',
            text: `Cześć ${m.nick}!\n\nAby ustawić nowe hasło, otwórz ten link (ważny 1 godzinę):\n${link}\n\nJeśli to nie Ty prosiłeś o zmianę hasła, zignoruj tę wiadomość.`,
          }),
        });
        if (!r.ok) console.error('resend', r.status, await r.text());
      } catch (e) { console.error('resend', e); }
    }
    return out;
  },

  async acctReset(body) {
    const err = checkPassword(body.password);
    if (err) this.fail(err);
    const hash = await this.sha256(String(body.token ?? ''));
    const r = this.sql.exec('SELECT * FROM resets WHERE hash = ?', hash).toArray()[0];
    if (!r || r.expires_at < Date.now()) this.fail('Link do zmiany hasła wygasł albo został już użyty.');
    const m = this.member(r.member_id);
    this.sql.exec('DELETE FROM resets WHERE member_id = ?', m.id);
    this.sql.exec('DELETE FROM tokens WHERE member_id = ?', m.id); // wyloguj wszystkie urządzenia
    this.sql.exec('DELETE FROM login_fails WHERE nick_key = ?', m.nick_key);
    this.sql.exec('UPDATE members SET pass_hash = ? WHERE id = ?', await hashPassword(String(body.password), this.pbkdf2Iterations()), m.id);
    const token = await this.issueToken(m.id);
    return { name: this.kv('name'), memberId: m.id, nick: m.nick, token, rooms: this.acctRooms(m.id) };
  },
};

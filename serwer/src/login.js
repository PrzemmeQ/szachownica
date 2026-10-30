// Logowanie bez wpisywania hasła — część poczekalni ogólnej (tam są konta):
// • QR: komputer pokazuje kod, zalogowany telefon go skanuje i zatwierdza („Zaloguj komputer”),
// • klucze dostępu (passkey): Face ID / odcisk palca / PIN urządzenia; hasło zostaje jako zapas,
// • wylogowanie wszystkich urządzeń (także kluczy klubów na innych urządzeniach).
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const QR_TTL = 2 * 60000; // kod QR ważny 2 minuty
const CHALLENGE_TTL = 5 * 60000;
const SHORT_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const b64u = {
  enc(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};
function shortCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => SHORT_ALPHA[x % SHORT_ALPHA.length]).join('');
}
// Krótki opis urządzenia z User-Agent (do pytania „Zalogować komputer (Windows · Chrome)?”).
export function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) && !/iPhone|iPad/.test(s) ? 'Mac' : /Android/.test(s) ? 'Android'
    : /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Linux/.test(s) ? 'Linux' : 'urządzenie';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'przeglądarka';
  return `${os} · ${br}`;
}

export const loginMethods = {
  migrateLogin() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS qr_logins (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, short TEXT NOT NULL UNIQUE, device TEXT, expires_at INTEGER NOT NULL,
        account_id TEXT, token TEXT);
      CREATE TABLE IF NOT EXISTS passkeys (
        cred_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
        transports TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS passkeys_account ON passkeys (account_id);
      CREATE TABLE IF NOT EXISTS wa_challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, account_id TEXT, expires_at INTEGER NOT NULL);
    `);
  },
  loginResult(m, token) { return { name: this.kv('name'), memberId: m.id, nick: m.nick, token, rooms: this.acctRooms(m.id) }; },

  // --- QR ---
  async qrStart(body, ip) {
    const limited = await this.takeLimit('qr', ip);
    if (limited) this.fail(limited);
    const now = Date.now();
    this.sql.exec('DELETE FROM qr_logins WHERE expires_at < ?', now);
    const id = this.randomCode(16);
    const secret = this.randomCode(24);
    let short;
    do { short = shortCode(); } while (this.sql.exec('SELECT 1 FROM qr_logins WHERE short = ?', short).toArray().length);
    this.sql.exec('INSERT INTO qr_logins (id, secret_hash, short, device, expires_at) VALUES (?, ?, ?, ?, ?)',
      id, await this.sha256(secret), short, deviceLabel(body.ua), now + QR_TTL);
    return { id, secret, short, expiresIn: QR_TTL / 1000 };
  },
  // Komputer pyta co 2 s: czeka / zatwierdzone (jednorazowo oddaje klucz konta) / wygasło.
  async qrPoll(body) {
    const row = this.sql.exec('SELECT * FROM qr_logins WHERE id = ?', String(body.id || '')).toArray()[0];
    if (!row || row.secret_hash !== await this.sha256(String(body.secret || ''))) return { status: 'expired' };
    if (row.token) {
      this.sql.exec('DELETE FROM qr_logins WHERE id = ?', row.id);
      const m = this.member(row.account_id);
      return m ? { status: 'approved', ...this.loginResult(m, row.token) } : { status: 'expired' };
    }
    if (row.expires_at < Date.now()) { this.sql.exec('DELETE FROM qr_logins WHERE id = ?', row.id); return { status: 'expired' }; }
    return { status: 'waiting' };
  },
  qrFind(code) {
    const c = String(code || '').trim();
    const row = this.sql.exec('SELECT * FROM qr_logins WHERE (id = ? OR short = ?) AND expires_at > ? AND token IS NULL',
      c, c.toUpperCase().replace(/[^A-Z0-9]/g, ''), Date.now()).toArray()[0];
    if (!row) this.fail('Kod logowania jest zły albo wygasł. Na komputerze kliknij „Zaloguj telefonem” jeszcze raz.');
    return row;
  },
  // Telefon (zalogowany): najpierw podgląd „jakie urządzenie”, potem zatwierdzenie.
  cmdQrInfo(code) { const r = this.qrFind(code); return { device: r.device, short: r.short }; },
  async cmdQrApprove(me, code) {
    const r = this.qrFind(code);
    this.sql.exec('UPDATE qr_logins SET account_id = ?, token = ? WHERE id = ?', me, await this.issueToken(me), r.id);
    return { device: r.device };
  },

  // --- klucze dostępu (WebAuthn) ---
  rp(origin) {
    if (!origin) this.fail('Odśwież stronę i spróbuj ponownie.');
    return { rpID: new URL(origin).hostname, origin };
  },
  saveChallenge(challenge, accountId) {
    const id = this.randomCode(16);
    this.sql.exec('DELETE FROM wa_challenges WHERE expires_at < ?', Date.now());
    this.sql.exec('INSERT INTO wa_challenges (id, challenge, account_id, expires_at) VALUES (?, ?, ?, ?)', id, challenge, accountId, Date.now() + CHALLENGE_TTL);
    return id;
  },
  takeChallenge(id) {
    const row = this.sql.exec('SELECT * FROM wa_challenges WHERE id = ?', String(id || '')).toArray()[0];
    this.sql.exec('DELETE FROM wa_challenges WHERE id = ?', String(id || ''));
    if (!row || row.expires_at < Date.now()) this.fail('Minął czas na potwierdzenie. Spróbuj jeszcze raz.');
    return row;
  },
  async needAcct(token) {
    const a = await this.acctVerify(token);
    if (!a) this.fail('Sesja konta wygasła — zaloguj się ponownie.');
    return a;
  },
  async passkeyRegOptions(body, origin) {
    const a = await this.needAcct(body.accountToken);
    const { rpID } = this.rp(origin);
    const existing = this.sql.exec('SELECT cred_id, transports FROM passkeys WHERE account_id = ?', a.id).toArray();
    const options = await generateRegistrationOptions({
      rpName: 'Przy Szachownicy', rpID, userName: a.nick, userDisplayName: a.nick,
      userID: new TextEncoder().encode(a.id), attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.cred_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { options, challengeId: this.saveChallenge(options.challenge, a.id) };
  },
  async passkeyRegister(body, origin) {
    const a = await this.needAcct(body.accountToken);
    const ch = this.takeChallenge(body.challengeId);
    if (ch.account_id !== a.id) this.fail('Spróbuj jeszcze raz.');
    const { rpID } = this.rp(origin);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) { this.fail('Nie udało się dodać klucza: ' + e.message); }
    if (!v.verified) this.fail('Nie udało się dodać klucza.');
    const c = v.registrationInfo.credential;
    this.sql.exec('INSERT OR REPLACE INTO passkeys (cred_id, account_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      c.id, a.id, b64u.enc(c.publicKey), c.counter, JSON.stringify(c.transports || body.response?.response?.transports || []), Date.now());
    return { ok: true, passkeys: this.passkeyCount(a.id) };
  },
  passkeyCount(accountId) { return this.sql.exec('SELECT COUNT(*) AS c FROM passkeys WHERE account_id = ?', accountId).one().c; },
  async passkeyLoginOptions(body, origin, ip) {
    const limited = await this.takeLimit('passkey', ip);
    if (limited) this.fail(limited);
    const { rpID } = this.rp(origin);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    return { options, challengeId: this.saveChallenge(options.challenge, null) };
  },
  async passkeyLogin(body, origin) {
    const ch = this.takeChallenge(body.challengeId);
    const credId = String(body.response?.id || '');
    const pk = this.sql.exec('SELECT * FROM passkeys WHERE cred_id = ?', credId).toArray()[0];
    if (!pk) this.fail('Ten klucz dostępu nie jest przypisany do żadnego konta. Zaloguj się hasłem i dodaj go w menu konta.');
    const m = this.member(pk.account_id);
    if (!m || m.removed) this.fail('Nie ma już tego konta.');
    const { rpID } = this.rp(origin);
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: pk.cred_id, publicKey: b64u.dec(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined },
      });
    } catch (e) { this.fail('Nie udało się zalogować: ' + e.message); }
    if (!v.verified) this.fail('Nie udało się zalogować kluczem dostępu.');
    this.sql.exec('UPDATE passkeys SET counter = ? WHERE cred_id = ?', v.authenticationInfo.newCounter, pk.cred_id);
    return this.loginResult(m, await this.issueToken(m.id));
  },
  cmdPasskeysRemove(me) {
    this.sql.exec('DELETE FROM passkeys WHERE account_id = ?', me);
    return { passkeys: 0 };
  },

  // --- wylogowanie wszędzie: klucze konta i klucze klubów (zostaje tylko bieżące urządzenie) ---
  async cmdLogoutAll(me, keepHash) {
    this.sql.exec('DELETE FROM tokens WHERE member_id = ? AND hash != ?', me, keepHash);
    for (const r of this.acctRooms(me)) {
      if (r.status === 'member') await this.callRoom(r.room, 'revoke-account', { accountId: me }).catch(() => null);
    }
    for (const ws of this.openSockets()) {
      const a = this.att(ws);
      if (a.memberId === me && a.th !== keepHash) { this.send(ws, { t: 'authFailed', message: 'Wylogowano na wszystkich urządzeniach.' }); try { ws.close(4001, 'auth'); } catch {} }
    }
    return {};
  },
};

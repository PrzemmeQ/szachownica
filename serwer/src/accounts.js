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

// Najczęściej używane hasła (świat + Polska), od 8 znaków — takie odgaduje się w pierwszej kolejności.
const COMMON = new Set(`
12345678 123456789 1234567890 0123456789 87654321 987654321 11111111 00000000 22222222 88888888 12341234 11223344
12121212 123123123 1q2w3e4r 1q2w3e4r5t 1qaz2wsx qwertyui qwertyuiop qwerty123 qwerty12 qwertyu1 asdfghjk asdfghjkl
zxcvbnm1 zaq12wsx zaq1zaq1 password password1 password123 passw0rd p@ssw0rd p@ssword iloveyou iloveyou1 princess
sunshine football baseball superman batman123 starwars whatever trustno1 letmein1 welcome1 welcome123 admin123
administrator abc12345 abcd1234 abcdefgh aaaaaaaa q1w2e3r4 monkey12 dragon12 master12 shadow12 michael1 jennifer
computer internet samsung1 linkedin facebook google123 changeme default1 secret12 test1234 testtest 1234qwer
haslo123 haslo1234 haslo12345 hasło123 mojehaslo mojehasło haslohaslo kochanie kochanie1 kochamcie misiaczek
zaq1@wsx polska12 polska123 polska1234 warszawa krakow123 legia123 lech1234 qazwsxedc qwe12345 asd12345 zxc12345
szachy123 szachownica szachista szachmat szachmat1 lichess1 lichess123 przyszachownicy chess123 chessmaster
magnus123 carlsen1 hetman12 skoczek1 gambit12 checkmate checkmate1 grandmaster
`.trim().split(/\s+/));

function tooSimple(s) {
  const low = s.toLowerCase();
  if (COMMON.has(low)) return true;
  if (/^(.)\1+$/.test(s)) return true; // aaaaaaaa
  if (/^(.{1,4})\1+$/.test(low)) return true; // abcabcabc, 12121212
  const seq = 'abcdefghijklmnopqrstuvwxyz0123456789 qwertyuiopasdfghjklzxcvbnm 1qaz2wsx3edc4rfv5tgb';
  if (seq.includes(low) || seq.split('').reverse().join('').includes(low)) return true; // 12345678, abcdefgh, qwertyui
  return false;
}

export function checkPassword(p, nick) {
  const s = String(p ?? '');
  if (s.length < 8) return 'Hasło musi mieć co najmniej 8 znaków.';
  if (s.length > 200) return 'Hasło jest za długie.';
  if (tooSimple(s)) return 'To hasło jest zbyt popularne albo za proste — łatwo je odgadnąć. Wymyśl inne.';
  if (nick && s.toLowerCase().includes(String(nick).toLowerCase())) return 'Hasło nie może zawierać nicku.';
  return null;
}
export function cleanEmail(e) {
  const s = String(e ?? '').trim();
  if (!s) return { email: null, key: null };
  if (!EMAIL_RE.test(s)) return { error: 'Sprawdź adres e-mail.' };
  return { email: s, key: s.toLowerCase() };
}

// Metody dodawane do klasy Room (this = obiekt pokoju). Wywoływane tylko w poczekalni ogólnej.
// Limity zakładania (na godzinę): z jednego adresu i łącznie. Szkółka na jednym Wi-Fi zmieści grupę.
const LIMITS = {
  register: { perIp: 10, total: 300 }, room: { perIp: 10, total: 300 }, statsfail: { perIp: 10, total: 1000 },
  clubjoin: { perIp: 30, total: 100000 }, transferfail: { perIp: 10, total: 10000 },
};

export const accountMethods = {
  pbkdf2Iterations() { return this.test ? 1000 : PBKDF2_MAX; },
  lockLimits() { return this.test ? { fails: 3, ms: 3000 } : { fails: 5, ms: 15 * 60000 }; },

  // Skrót adresu z solą zmienianą codziennie: nie da się z niego odtworzyć adresu ani połączyć dni.
  async ipKey(ip) {
    if (!ip) return 'brak';
    const day = new Date().toISOString().slice(0, 10);
    let salt = this.kv('ip_salt_' + day);
    if (!salt) {
      this.sql.exec("DELETE FROM kv WHERE k LIKE 'ip_salt_%'");
      salt = this.randomCode(24);
      this.kv('ip_salt_' + day, salt);
    }
    return (await this.sha256(salt + '|' + ip)).slice(0, 20);
  },

  // Zwraca komunikat błędu albo null (i zapisuje zdarzenie). Wpisy starsze niż godzina są kasowane.
  async takeLimit(kind, ip) {
    const now = Date.now();
    this.sql.exec('DELETE FROM limits WHERE at < ?', now - 3600000);
    const key = await this.ipKey(ip);
    const L = { ...LIMITS[kind] };
    // testy rejestrują wiele kont z jednego komputera; prawdziwy limit sprawdzamy adresami „test-limit-…”
    if (this.test) { L.total = 1e9; L.perIp = String(ip).startsWith('test-limit-') ? 3 : 1e9; }
    const mine = this.sql.exec('SELECT COUNT(*) AS c FROM limits WHERE kind = ? AND ip_key = ?', kind, key).one().c;
    const all = this.sql.exec('SELECT COUNT(*) AS c FROM limits WHERE kind = ?', kind).one().c;
    if (mine >= L.perIp) {
      return kind === 'room' ? 'Z tej sieci założono w ostatniej godzinie zbyt wiele pokoi. Spróbuj później.'
        : 'Z tej sieci założono w ostatniej godzinie zbyt wiele kont. Spróbuj później.';
    }
    if (all >= L.total) return 'Serwer ma teraz zbyt wiele nowych rejestracji. Spróbuj za kilkanaście minut.';
    this.sql.exec('INSERT INTO limits (kind, ip_key, at) VALUES (?, ?, ?)', kind, key, now);
    return null;
  },

  async setEmail(memberId, email) {
    const e = cleanEmail(email);
    if (e.error) this.fail(e.error);
    if (e.key && this.sql.exec('SELECT 1 FROM members WHERE email_key = ? AND id != ?', e.key, memberId).toArray().length) {
      this.fail('Ten adres e-mail jest już przypisany do innego konta.');
    }
    this.sql.exec('UPDATE members SET email = ?, email_key = ? WHERE id = ?', e.email, e.key, memberId);
  },

  async acctRegister(body, ip) {
    const err = checkPassword(body.password, body.nick);
    if (err) this.fail(err);
    const e = cleanEmail(body.email);
    if (e.error) this.fail(e.error);
    if (e.key && this.sql.exec('SELECT 1 FROM members WHERE email_key = ?', e.key).toArray().length) {
      this.fail('Ten adres e-mail jest już przypisany do innego konta.');
    }
    this.checkNewNick(body.nick);
    const limited = await this.takeLimit('register', ip);
    if (limited) this.fail(limited);
    const m = await this.addMember(body.nick, 'member');
    this.statRecord({ kind: 'account' });
    this.sql.exec('UPDATE members SET pass_hash = ?, email = ?, email_key = ? WHERE id = ?',
      await hashPassword(String(body.password), this.pbkdf2Iterations()), e.email, e.key, m.memberId);
    return { name: this.kv('name'), ...m, rooms: [] };
  },

  // Blokada liczona dla pary nick + sieć: ktoś obcy nie zablokuje Ci logowania, zgadując z innej sieci.
  async acctLogin(body, ip) {
    const key = this.nickKey(body.nick) + '|' + await this.ipKey(ip);
    const now = Date.now();
    const lock = this.sql.exec('SELECT * FROM login_fails WHERE nick_key = ?', key).toArray()[0];
    if (lock && lock.until > now) {
      this.fail(`Za dużo nieudanych prób. Spróbuj za ${Math.ceil((lock.until - now) / 60000)} min.`);
    }
    const m = this.sql.exec('SELECT * FROM members WHERE nick_key = ?', this.nickKey(body.nick)).toArray()[0];
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

  // „Moje kluby” przy koncie: identyfikator pokoju i nazwa.
  // status: member | pending (czeka na zatwierdzenie) | invited (zaproszony przez założyciela/admina)
  acctAddRoom(accountId, roomId, name, status = 'member') {
    if (!this.member(accountId)) return;
    this.sql.exec('INSERT OR REPLACE INTO account_rooms (member_id, room_id, name, joined_at, status) VALUES (?, ?, ?, ?, ?)',
      accountId, roomId, name, Date.now(), status);
  },
  acctRemoveRoom(accountId, roomId) {
    this.sql.exec('DELETE FROM account_rooms WHERE member_id = ? AND room_id = ?', accountId, roomId);
  },
  acctRooms(accountId) {
    return this.sql.exec('SELECT room_id AS room, name, status FROM account_rooms WHERE member_id = ? ORDER BY joined_at DESC', accountId).toArray();
  },
  // Zmiana statusu klubu u konta (zatwierdzenie, odrzucenie, zaproszenie) + powiadomienie, gdy jest online.
  acctRoomStatus({ accountId, roomId, name, status, event }) {
    const id = String(accountId || '');
    if (status) this.acctAddRoom(id, String(roomId), String(name || ''), status);
    else this.acctRemoveRoom(id, String(roomId));
    this.toMember(id, { t: 'myRooms', rooms: this.acctRooms(id) });
    if (event) this.toMember(id, { t: 'event', ev: { type: 'clubStatus', name, event, room: roomId } });
  },
  acctFind(nick) {
    const m = this.sql.exec('SELECT id, nick FROM members WHERE nick_key = ? AND removed = 0', this.nickKey(String(nick || ''))).toArray()[0];
    return m ? { id: m.id, nick: m.nick } : {};
  },

  // --- wspólny ranking (jeden na konto dla każdego tempa, dla poczekalni i wszystkich klubów) ---
  acctRatings(ids) {
    const out = {};
    for (const id of (ids || []).slice(0, 200)) out[id] = this.ratingsOf(String(id));
    return out;
  },
  // Wynik partii rankingowej. Ochrona przed nabijaniem: z tym samym rywalem najwyżej 3 partie rankingowe dziennie.
  acctRate(body) {
    const w = String(body.white || ''), b = String(body.black || '');
    if (!this.member(w) || !this.member(b) || w === b) return { counted: false, reason: 'account' };
    const sp = body.speed === 'classical' ? 'classical' : 'rapid';
    const day = new Date().toISOString().slice(0, 10);
    const [x, y] = w < b ? [w, b] : [b, w];
    const n = this.sql.exec('SELECT n FROM pair_days WHERE a = ? AND b = ? AND day = ?', x, y, day).toArray()[0]?.n || 0;
    if (n >= 3) return { counted: false, reason: 'limit' };
    this.sql.exec(`INSERT INTO pair_days (a, b, day, n) VALUES (?, ?, ?, 1)
      ON CONFLICT (a, b, day) DO UPDATE SET n = n + 1`, x, y, day);
    const rw = this.rating(w, sp), rb = this.rating(b, sp);
    const res = this.rateGameGlicko(rw, rb, body.score);
    this.saveRating({ ...rw, ...res.white, games: rw.games + 1 });
    this.saveRating({ ...rb, ...res.black, games: rb.games + 1 });
    return {
      counted: true,
      diffW: Math.round(res.white.rating) - Math.round(rw.rating),
      diffB: Math.round(res.black.rating) - Math.round(rb.rating),
      ratings: this.acctRatings([w, b]),
    };
  },

  accountInfo(memberId) {
    const m = this.member(memberId);
    return { hasPassword: !!m?.pass_hash, email: m?.email || null };
  },

  // Ustawienie lub zmiana hasła (i e-maila) przez zalogowane urządzenie.
  // currentHash: skrót klucza tego urządzenia — po zmianie hasła inne urządzenia zostają wylogowane.
  async acctSetPassword(me, msg, currentHash) {
    const m = this.member(me);
    if (msg.password != null && msg.password !== '') {
      if (m.pass_hash && !(await verifyPassword(String(msg.oldPassword ?? ''), m.pass_hash))) this.fail('Obecne hasło jest nieprawidłowe.');
      const err = checkPassword(msg.password, m.nick);
      if (err) this.fail(err);
      this.sql.exec('UPDATE members SET pass_hash = ? WHERE id = ?', await hashPassword(String(msg.password), this.pbkdf2Iterations()), me);
      if (m.pass_hash) this.sql.exec('DELETE FROM tokens WHERE member_id = ? AND hash != ?', me, currentHash || '');
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
    // token po # — nie trafia do logów serwera stron ani do nagłówka Referer
    const link = `${this.env.APP_URL || 'https://przemmeq.github.io/szachownica/przy-szachownicy/'}#reset=${token}`;
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
    const hash = await this.sha256(String(body.token ?? ''));
    const r = this.sql.exec('SELECT * FROM resets WHERE hash = ?', hash).toArray()[0];
    if (!r || r.expires_at < Date.now()) this.fail('Link do zmiany hasła wygasł albo został już użyty.');
    const m = this.member(r.member_id);
    const err = checkPassword(body.password, m.nick);
    if (err) this.fail(err);
    this.sql.exec('DELETE FROM resets WHERE member_id = ?', m.id);
    this.sql.exec('DELETE FROM tokens WHERE member_id = ?', m.id); // wyloguj wszystkie urządzenia
    this.sql.exec('DELETE FROM login_fails WHERE nick_key LIKE ?', m.nick_key + '|%');
    this.sql.exec('UPDATE members SET pass_hash = ? WHERE id = ?', await hashPassword(String(body.password), this.pbkdf2Iterations()), m.id);
    const token = await this.issueToken(m.id);
    return { name: this.kv('name'), memberId: m.id, nick: m.nick, token, rooms: this.acctRooms(m.id) };
  },
};

// Kluby (prywatne pokoje) — część, którą prowadzi poczekalnia ogólna (jedno miejsce dla wszystkich):
// katalog kodów klubów, dołączanie kodem z blokadą za błędne próby, krótkie kody przeniesienia.
//
// Kod klubu: pierwsze 5 liter/cyfr nazwy + „-” + 5 losowych znaków, np. „KLUBH-7Q4MX”.
// Pokój ma stały, wewnętrzny identyfikator (12 znaków) — kod można zmienić, pokój zostaje.

const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CLUB_CODE_RE = /^[A-Z0-9]{1,5}-[A-Z0-9]{5}$/;

// Blokada dołączania (nie gry) po błędnych kodach/hasłach, rosnąca:
// 10 błędów → 3 dni, potem 5 → 7 dni, potem 3 → 2 miesiące, potem 3 → na stałe.
const LOCK_STEPS = [
  { fails: 10, ms: 3 * 86400000 },
  { fails: 5, ms: 7 * 86400000 },
  { fails: 3, ms: 60 * 86400000 },
  { fails: 3, ms: Infinity },
];
const TEST_LOCK_STEPS = [
  { fails: 3, ms: 3000 }, { fails: 2, ms: 3000 }, { fails: 2, ms: 3000 }, { fails: 2, ms: Infinity },
];

function randomFrom(alpha, n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => alpha[x % alpha.length]).join('');
}
// „Klub Hetman — środy” → „KLUBH”
export function codePrefix(name) {
  const p = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/gi, 'L')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  return p.length >= 2 ? p : 'KLUB';
}
export function normalizeCode(c) {
  const s = String(c || '').toUpperCase().replace(/\s+/g, '');
  if (CLUB_CODE_RE.test(s)) return s;
  const m = s.replace(/[^A-Z0-9]/g, '').match(/^([A-Z0-9]{1,5})([A-Z0-9]{5})$/); // bez myślnika
  return m ? `${m[1]}-${m[2]}` : s;
}

export const clubMethods = {
  lockSteps() { return this.test ? TEST_LOCK_STEPS : LOCK_STEPS; },

  // Nowy, niepowtarzalny kod dla pokoju (przy zakładaniu i przy zmianie kodu).
  clubNewCode(roomId, name) {
    let code;
    do { code = `${codePrefix(name)}-${randomFrom(CODE_ALPHA, 5)}`; }
    while (this.sql.exec('SELECT 1 FROM room_dir WHERE code = ?', code).toArray().length);
    this.sql.exec('INSERT OR REPLACE INTO room_dir (room_id, code, name, created_at) VALUES (?, ?, ?, ?)', roomId, code, name, Date.now());
    return code;
  },

  // --- blokada: klucz = konto (a:id); d:id zostało po dawnym dołączaniu bez konta ---
  lockState(key) {
    return this.sql.exec('SELECT * FROM code_locks WHERE key = ?', key).toArray()[0] || { key, stage: 0, fails: 0, banned_until: 0 };
  },
  lockCheck(key) {
    const s = this.lockState(key);
    if (s.banned_until > Date.now()) {
      const forever = s.banned_until >= 8e15;
      this.fail(forever ? 'Dołączanie do klubów jest zablokowane na stałe po wielu błędnych kodach.'
        : `Za dużo błędnych kodów. Dołączanie do klubów zablokowane do ${new Date(s.banned_until).toLocaleString('pl-PL')}.`);
    }
  },
  lockFail(key) {
    const s = this.lockState(key);
    const steps = this.lockSteps();
    const step = steps[Math.min(s.stage, steps.length - 1)];
    let { stage, fails, banned_until: until } = s;
    fails++;
    let left = step.fails - fails;
    if (fails >= step.fails) {
      until = step.ms === Infinity ? 9e15 : Date.now() + step.ms;
      stage = Math.min(stage + 1, steps.length - 1);
      fails = 0;
      left = 0;
    }
    this.sql.exec('INSERT OR REPLACE INTO code_locks (key, stage, fails, banned_until) VALUES (?, ?, ?, ?)', key, stage, fails, until);
    return left;
  },
  lockSuccess(key) {
    this.sql.exec('UPDATE code_locks SET fails = 0 WHERE key = ?', key);
  },
  lockKey(account, deviceId) {
    if (account) return 'a:' + account.id;
    const d = String(deviceId || '').slice(0, 40);
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(d)) this.fail('Odśwież aplikację i spróbuj ponownie.');
    return 'd:' + d;
  },
  wrongCode(key) {
    const left = this.lockFail(key);
    this.fail(left > 0 ? `Nie ma klubu o takim kodzie albo hasło jest złe. Pozostało prób: ${left}.`
      : 'Nie ma klubu o takim kodzie albo hasło jest złe. Dołączanie zostało czasowo zablokowane.');
  },

  // Sprawdzenie kodu przed dołączeniem (ekran „Dołącz do klubu”): nazwa i czy potrzebne hasło.
  async clubLookup(body) {
    const account = await this.needAccount(body.accountToken);
    const key = this.lockKey(account);
    this.lockCheck(key);
    const code = normalizeCode(body.code);
    const row = CLUB_CODE_RE.test(code) && this.sql.exec('SELECT * FROM room_dir WHERE code = ?', code).toArray()[0];
    if (!row) this.wrongCode(key);
    const info = await this.callRoom(row.room_id, 'info', {});
    return { code, name: row.name, needsPassword: !!info?.needsPassword };
  },

  // Dołączenie kodem (i hasłem, jeśli klub je ma). Pokój sam sprawdza kod i hasło.
  // Dołączenie kodem (i hasłem, jeśli klub je ma). Pokój sam sprawdza kod i hasło;
  // przy włączonym zatwierdzaniu zwraca { pending } — klub trafia do „Moich klubów” jako oczekujący.
  async clubJoin(body) {
    const account = await this.needAccount(body.accountToken);
    const key = this.lockKey(account);
    this.lockCheck(key);
    const code = normalizeCode(body.code);
    const row = CLUB_CODE_RE.test(code) && this.sql.exec('SELECT * FROM room_dir WHERE code = ?', code).toArray()[0];
    if (!row) this.wrongCode(key);
    const res = await this.callRoomRaw(row.room_id, 'join', {
      code, password: body.password, nick: body.nick, accountId: account.id, accountNick: account.nick,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.wrongPassword) this.wrongCode(key);
    if (!res.ok) this.fail(data.error || 'Nie udało się dołączyć.');
    this.lockSuccess(key);
    this.acctAddRoom(account.id, row.room_id, row.name, data.pending ? 'pending' : 'member');
    return { room: row.room_id, code, ...data };
  },
  async needAccount(token) {
    const account = token ? await this.acctVerify(token) : null;
    if (!account) this.fail('Do klubu dołączasz z kontem — zaloguj się albo załóż konto.');
    return account;
  },

  // Krótki, 6-cyfrowy kod przeniesienia na inne urządzenie (łatwy do przepisania, np. na iPhonie).
  clubTransferRegister(roomId, code12) {
    const now = Date.now();
    this.sql.exec('DELETE FROM transfer_codes WHERE expires_at < ?', now);
    let code6;
    do { code6 = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)); }
    while (this.sql.exec('SELECT 1 FROM transfer_codes WHERE code6 = ?', code6).toArray().length);
    this.sql.exec('INSERT INTO transfer_codes (code6, room_id, code12, expires_at) VALUES (?, ?, ?, ?)', code6, roomId, code12, now + 10 * 60000);
    return code6;
  },
  async clubTransferClaim(body, ip) {
    const limited = await this.takeLimit('transferfail', ip);
    if (limited) this.fail('Zbyt wiele prób. Spróbuj za godzinę.');
    const code6 = String(body.code || '').replace(/\D/g, '');
    const row = this.sql.exec('SELECT * FROM transfer_codes WHERE code6 = ? AND expires_at > ?', code6, Date.now()).toArray()[0];
    if (!row) this.fail('Kod przeniesienia jest zły albo wygasł (ważny 10 minut).');
    this.sql.exec('DELETE FROM transfer_codes WHERE code6 = ?', code6);
    const res = await this.callRoomRaw(row.room_id, 'transfer', { code: row.code12 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) this.fail(data.error || 'Kod przeniesienia wygasł.');
    return { room: row.room_id, ...data };
  },

  // --- wywołania pokoju (serwer–serwer) ---
  roomStubFor(roomId) {
    const ns = this.env.JURISDICTION ? this.env.ROOMS.jurisdiction(this.env.JURISDICTION) : this.env.ROOMS;
    return ns.get(ns.idFromName(roomId));
  },
  callRoomRaw(roomId, action, body) {
    return this.roomStubFor(roomId).fetch('https://pokoj/' + action, {
      method: 'POST', headers: { 'X-Room': roomId, 'X-Internal': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  },
  async callRoom(roomId, action, body) {
    const res = await this.callRoomRaw(roomId, action, body);
    return res.ok ? res.json() : null;
  },
};

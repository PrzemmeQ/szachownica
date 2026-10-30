// Worker: punkt wejścia. Przekazuje zapytania do obiektu pokoju (Durable Object).
//
// POST /api/rooms                         { name, nick }  → { room, memberId, token }
// GET  /api/rooms/:kod                                     → { name, members }
// POST /api/rooms/:kod/join               { nick }        → { memberId, token }
// POST /api/rooms/:kod/transfer           { code }        → { memberId, nick, token }
// GET  /api/rooms/:kod/ws                 (WebSocket, pierwsza wiadomość: hello{token})
// Kod „publiczny” = poczekalnia ogólna (tworzy się sama przy pierwszym wejściu).
// POST /api/rooms/:kod/account-login      { accountToken }  → { memberId, nick, token }
// POST /api/account/register              { nick, password, email? } → { memberId, nick, token }
// POST /api/account/login                 { nick, password } → { memberId, nick, token, rooms }
// POST /api/account/reset-request         { login }  (nick lub e-mail) → { ok, mailEnabled }
// POST /api/account/reset                 { token, password } → { memberId, nick, token, rooms }
import { Room, ROOM_CODE_RE, PUBLIC_CODE, randomCode } from './room.js';

export { Room };

function allowedOrigin(env, origin) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function cors(env, req, res) {
  const origin = allowedOrigin(env, req.headers.get('Origin'));
  if (!origin || res.status === 101) return res;
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h, webSocket: res.webSocket });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function roomStub(env, code) {
  const ns = env.JURISDICTION ? env.ROOMS.jurisdiction(env.JURISDICTION) : env.ROOMS;
  return ns.get(ns.idFromName(code));
}

// Adres klienta tylko do limitów (pokój go nie zapisuje — trzyma skrót z dzienną solą, najwyżej godzinę).
// Nagłówek ustawia Cloudflare; klient go nie podrobi. X-Test-IP działa tylko w trybie testowym.
function clientIp(req, env) {
  if (env.TEST_MODE === '1' && req.headers.get('X-Test-IP')) return req.headers.get('X-Test-IP');
  return req.headers.get('CF-Connecting-IP') || '';
}

async function forward(env, code, action, req, body) {
  const stub = roomStub(env, code);
  // nagłówki budujemy od zera — klient nie przemyci X-Room ani X-Client-IP
  const init = { method: req.method, headers: { 'X-Room': code, 'X-Client-IP': clientIp(req, env) } };
  if (body !== undefined) { init.method = 'POST'; init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  return stub.fetch('https://pokoj/' + action, init);
}

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');

    if (req.method === 'OPTIONS') {
      const o = allowedOrigin(env, origin);
      if (!o) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': o,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    // Przeglądarka z obcej strony nie dostanie się do serwera (CORS + sprawdzenie Origin przy WebSocket).
    if (origin && !allowedOrigin(env, origin)) return json({ error: 'Niedozwolone źródło.' }, 403);

    const res = await route(req, env, url);
    return cors(env, req, res);
  },
};

async function route(req, env, url) {
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'api') return json({ error: 'Nie znaleziono.' }, 404);

  if (parts[1] === 'health') return json({ ok: true });

  // konta: POST /api/account/(register|login|reset-request|reset)
  if (parts[1] === 'account' && req.method === 'POST' && ['register', 'login', 'reset-request', 'reset'].includes(parts[2])) {
    return forward(env, PUBLIC_CODE, 'acct-' + parts[2], req, await readJson(req));
  }

  if (parts[1] !== 'rooms') return json({ error: 'Nie znaleziono.' }, 404);

  // utworzenie pokoju
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    // limit zakładania pokoi liczy poczekalnia ogólna (jedno miejsce dla wszystkich pokoi)
    const lim = await forward(env, PUBLIC_CODE, 'acct-limit', req, { kind: 'room' });
    if (!lim.ok) return lim;
    for (let i = 0; i < 5; i++) {
      const code = randomCode(12);
      const res = await forward(env, code, 'create', req, { name: body.name, nick: body.nick, accountToken: body.accountToken });
      if (res.status === 409) continue; // kod zajęty — losuj ponownie
      if (!res.ok) return res;
      const data = await res.json();
      return json({ room: code, ...data });
    }
    return json({ error: 'Nie udało się utworzyć pokoju. Spróbuj ponownie.' }, 500);
  }

  const code = (parts[2] || '').toLowerCase();
  if (!ROOM_CODE_RE.test(code) && code !== PUBLIC_CODE) return json({ error: 'Nieprawidłowy kod pokoju.' }, 404);
  const action = parts[3] || '';

  if (!action && req.method === 'GET') return forward(env, code, 'info', req);
  if (action === 'join' && req.method === 'POST') return forward(env, code, 'join', req, await readJson(req));
  if (action === 'transfer' && req.method === 'POST') return forward(env, code, 'transfer', req, await readJson(req));
  if (action === 'account-login' && req.method === 'POST' && code !== PUBLIC_CODE) {
    return forward(env, code, 'account-login', req, await readJson(req));
  }
  if (action === 'ws') {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'Oczekiwano WebSocket.' }, 426);
    const stub = roomStub(env, code);
    // tylko nagłówki potrzebne do WebSocket (bez nagłówków od klienta, które pokój mógłby wziąć za swoje)
    const h = new Headers();
    for (const k of ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Extensions', 'Origin']) {
      if (req.headers.get(k)) h.set(k, req.headers.get(k));
    }
    return stub.fetch(new Request('https://pokoj/ws', { headers: h }));
  }
  return json({ error: 'Nie znaleziono.' }, 404);
}

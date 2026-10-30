// Worker: punkt wejścia. Przekazuje zapytania do obiektów pokoi (Durable Objects).
//
// POST /api/account/register | login | reset-request | reset        (konta — poczekalnia ogólna)
// POST /api/rooms                 { name, nick?, accountToken? }    → { room, code, memberId, token }  (nowy klub)
// POST /api/rooms/lookup          { code, accountToken?, deviceId } → { code, name, needsPassword }
// POST /api/rooms/join            { code, password?, nick?, accountToken?, deviceId } → { room, code, memberId, nick, token }
// POST /api/rooms/transfer-code   { code }  (6 cyfr)               → { room, memberId, nick, token }
// POST /api/rooms/:id/account-login { accountToken }              → { memberId, nick, token }
// POST /api/rooms/:id/transfer    { code }  (link przeniesienia)
// GET  /api/rooms/:id/ws          (WebSocket, pierwsza wiadomość: hello{token}); „publiczny” = poczekalnia ogólna
// GET  /api/stats                 (Authorization: Bearer <STATS_KEY>)
import { Room, ROOM_ID_RE, PUBLIC_CODE, randomCode } from './room.js';

// Klasa obiektu nazywa się RoomV2: zmiana nazwy (migracja v2) wyczyściła dane testowe sprzed wspólnego rankingu.
export { Room as RoomV2 };

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
function roomStub(env, id) {
  const ns = env.JURISDICTION ? env.ROOMS.jurisdiction(env.JURISDICTION) : env.ROOMS;
  return ns.get(ns.idFromName(id));
}
// Adres klienta tylko do limitów (pokój trzyma skrót z dzienną solą, najwyżej godzinę). X-Test-IP tylko w testach.
function clientIp(req, env) {
  if (env.TEST_MODE === '1' && req.headers.get('X-Test-IP')) return req.headers.get('X-Test-IP');
  return req.headers.get('CF-Connecting-IP') || '';
}
// Nagłówki budujemy od zera — klient nie przemyci X-Room, X-Client-IP ani X-Internal.
async function forward(env, id, action, req, body, extraHeaders = {}) {
  const init = { method: req.method, headers: { ...extraHeaders, 'X-Room': id, 'X-Client-IP': clientIp(req, env) } };
  if (body !== undefined) { init.method = 'POST'; init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  return roomStub(env, id).fetch('https://pokoj/' + action, init);
}
async function readJson(req) { try { return await req.json(); } catch { return {}; } }

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') {
      const o = allowedOrigin(env, origin);
      if (!o) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
        },
      });
    }
    if (origin && !allowedOrigin(env, origin)) return json({ error: 'Niedozwolone źródło.' }, 403);
    return cors(env, req, await route(req, env, new URL(req.url)));
  },
};

async function route(req, env, url) {
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'api') return json({ error: 'Nie znaleziono.' }, 404);
  const post = req.method === 'POST';

  if (parts[1] === 'health') return json({ ok: true });
  if (parts[1] === 'stats' && parts.length === 2 && req.method === 'GET') {
    const key = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    return forward(env, PUBLIC_CODE, 'acct-stats', req, undefined, { 'X-Stats-Key': key });
  }
  if (parts[1] === 'account' && post && ['register', 'login', 'reset-request', 'reset'].includes(parts[2]) && parts.length === 3) {
    return forward(env, PUBLIC_CODE, 'acct-' + parts[2], req, await readJson(req));
  }
  if (parts[1] !== 'rooms') return json({ error: 'Nie znaleziono.' }, 404);

  // nowy klub: limit zakładania liczy poczekalnia ogólna; identyfikator pokoju jest wewnętrzny
  if (parts.length === 2 && post) {
    const body = await readJson(req);
    const lim = await forward(env, PUBLIC_CODE, 'acct-limit', req, { kind: 'room' });
    if (!lim.ok) return lim;
    for (let i = 0; i < 5; i++) {
      const id = randomCode(12);
      const res = await forward(env, id, 'create', req, { name: body.name, nick: body.nick, accountToken: body.accountToken });
      if (res.status === 409) continue;
      if (!res.ok) return res;
      return json({ room: id, ...(await res.json()) });
    }
    return json({ error: 'Nie udało się utworzyć klubu. Spróbuj ponownie.' }, 500);
  }
  if (parts.length === 3 && post && parts[2] === 'lookup') return forward(env, PUBLIC_CODE, 'acct-club-lookup', req, await readJson(req));
  if (parts.length === 3 && post && parts[2] === 'join') return forward(env, PUBLIC_CODE, 'acct-club-join', req, await readJson(req));
  if (parts.length === 3 && post && parts[2] === 'transfer-code') return forward(env, PUBLIC_CODE, 'acct-transfer-claim', req, await readJson(req));

  const id = (parts[2] || '').toLowerCase();
  if (!ROOM_ID_RE.test(id) && id !== PUBLIC_CODE) return json({ error: 'Nie ma takiego klubu.' }, 404);
  const action = parts[3] || '';
  if (action === 'account-login' && post && id !== PUBLIC_CODE) return forward(env, id, 'account-login', req, await readJson(req));
  if (action === 'transfer' && post) return forward(env, id, 'transfer', req, await readJson(req));
  if (action === 'ws') {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'Oczekiwano WebSocket.' }, 426);
    const h = new Headers();
    for (const k of ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Extensions', 'Origin']) {
      if (req.headers.get(k)) h.set(k, req.headers.get(k));
    }
    h.set('X-Room', id);
    return roomStub(env, id).fetch(new Request('https://pokoj/ws', { headers: h }));
  }
  return json({ error: 'Nie znaleziono.' }, 404);
}

// Pomocnicze do testów: lokalny `wrangler dev` i prosty klient WebSocket.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer(port = 8799) {
  const isWin = process.platform === 'win32';
  const cmd = `npx wrangler dev --port ${port} --ip 127.0.0.1 --persist-to .wrangler/test-state`;
  const proc = spawn(cmd, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode != null) throw new Error('wrangler dev zakończył się:\n' + log);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 60000) { proc.kill(); throw new Error('wrangler dev nie wystartował:\n' + log); }
    await sleep(300);
  }
  return {
    base,
    log: () => log,
    stop: () => new Promise((res) => {
      proc.once('exit', res);
      if (isWin) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      else proc.kill();
      setTimeout(res, 3000);
    }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(base, method, p, body) {
  const r = await fetch(base + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

export class Client {
  constructor(base, room, token) {
    this.url = base.replace(/^http/, 'ws') + `/api/rooms/${room}/ws`;
    this.token = token;
    this.msgs = [];
    this.waiters = [];
    this.seq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.msgs = [];
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: this.token }));
      ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.t === 'welcome') { this.welcome = m; resolve(m); }
        if (m.t === 'authFailed') resolve(m);
        for (const w of [...this.waiters]) {
          if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
        }
      };
      ws.onerror = (e) => reject(e.error || new Error('ws error'));
      ws.onclose = () => { this.closed = true; };
    });
  }

  // Czeka na wiadomość spełniającą warunek (także taką, która już przyszła od `since`).
  wait(pred, ms = 5000, since = 0) {
    const found = this.msgs.slice(since).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('timeout czekania na wiadomość')); }
      }, ms);
    });
  }
  mark() { return this.msgs.length; }

  async req(t, data = {}) {
    const reqId = ++this.seq;
    const p = this.wait((m) => m.t === 'res' && m.reqId === reqId);
    this.ws.send(JSON.stringify({ t, reqId, ...data }));
    return p;
  }

  gameMsg(gameId, type, since = 0, ms = 5000) {
    return this.wait((m) => m.t === 'game' && m.id === gameId && m.msg.type === type, ms, since).then((m) => m.msg);
  }

  close() { try { this.ws.close(); } catch {} }
}

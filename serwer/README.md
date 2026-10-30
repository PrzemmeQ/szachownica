# Serwer pokoi (wariant B)

Cloudflare Workers + Durable Objects. Jeden obiekt na pokój (SQLite w obiekcie): członkowie, wyzwania, partie, ranking Glicko-2 osobno dla blitza, rapida i klasycznych. Serwer sprawdza legalność ruchów (ten sam `chess.js` co front) i liczy zegar (alarmy).

## Lokalnie

```bash
npm install
npm run dev          # http://127.0.0.1:8787, ustawienia z .dev.vars (TEST_MODE=1: krótkie limity)
npm test             # testy serwera (same uruchamiają wrangler dev)
npx playwright install chromium
npm run test:e2e     # dwa telefony w Playwright + regresja wariantu A
```

## Wdrożenie (raz)

1. Załóż darmowe konto na cloudflare.com.
2. `npx wrangler login`
3. `npm run deploy` — wypisze adres, np. `https://przy-szachownicy.<konto>.workers.dev`.
4. Wpisz ten adres w `przy-szachownicy/config.js` jako `ROOMS_API` i wypchnij front na GitHub Pages.

`wrangler.jsonc`: `ALLOWED_ORIGINS` (domyślnie `https://przemmeq.github.io`), `JURISDICTION: "eu"` (pokoje tylko w UE), logi wyłączone.

## Protokół

HTTP: `POST /api/rooms`, `GET /api/rooms/:kod`, `POST /api/rooms/:kod/join`, `POST /api/rooms/:kod/transfer`.
WebSocket `/api/rooms/:kod/ws`: najpierw `hello{token}`, potem polecenia z `reqId` (`challenge`, `accept`, `watch`, `move{gameId,uci,ply}`, `draw`, `resign`, `abort`, `claimVictory`, `claimDraw`, `transferCreate`, `logout`…). Serwer wysyła `welcome`, `event` (kształty jak w Lichess), `game` (`full`/`state`/`opponentGone`), `members`, `challengeResult`, `res`. Klient: `przy-szachownicy/rooms.js`.

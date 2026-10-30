# Przy Szachownicy — plan wariantu B (B1)

Data: 30.10.2026. Uzupełnia `HANDOFF-wariant-B.md`.

## Decyzje

| temat | decyzja |
|---|---|
| Backend | **Cloudflare Workers + Durable Objects**, `jurisdiction("eu")` (do potwierdzenia na darmowym planie) |
| Pokoje | **jeden aktywny pokój** na urządzeniu (przełączanie przez link) |
| Inne urządzenie | **jednorazowy link/QR przeniesienia**, ważny 10 min |
| Ranking | **Glicko-2 osobno dla każdego tempa** (blitz / rapid / klasyczne) w obrębie pokoju |

## Architektura

- Jeden Durable Object na pokój, SQLite w obiekcie. Kod pokoju (12 losowych znaków) jest nazwą obiektu, więc nie ma globalnej bazy.
- Zaproszenie: `https://przemmeq.github.io/szachownica/przy-szachownicy/?pokoj=KOD`.
- Tożsamość: losowy token 256 bitów, serwer trzyma tylko SHA-256; urządzenie trzyma `{pokój, id, token}` w localStorage.
- Jedno połączenie WebSocket na urządzenie (API usypiania połączeń); `rooms.js` rozdziela ruch na `startEvents` i `streamGame`.
- Repo: `serwer/` obok `przy-szachownicy/`, importuje `../przy-szachownicy/chess.js`.

## Model danych

- `room(name, created_at, owner_id)`
- `members(id, nick, token_hash, role, joined_at, last_seen)`
- `ratings(member_id, speed, rating, rd, vol, games)`, speed ∈ blitz | rapid | classical
- `games(id, white_id, black_id, speed, time, inc, rated, status, winner, moves, wtime, btime, last_move_at, created_at, ended_at, rating_diff_w, rating_diff_b)`
- `transfers(code_hash, member_id, expires_at)`: linki przeniesienia, jednorazowe
- wyzwania tylko w pamięci, wygasają po 2 min

Bez adresów IP i e-maili; logi Workers wyłączone. Krótka polityka prywatności (`prywatnosc.html`).

## Protokół (JSON przez WebSocket)

Klient → serwer (każde z `reqId`, odpowiedź `res{reqId, ok, error?}`):
`hello{token}`, `challenge{to,time,inc,color,rated}`, `cancel{id}`, `accept{id}`, `decline{id}`,
`watch{gameId}`, `unwatch{gameId}`, `move{gameId,uci,ply}`, `draw{gameId,yes}`, `resign`, `abort`,
`claimVictory`, `claimDraw`, `transferCreate`.

Serwer → klient: `welcome{me, room, members, ongoing, challenges}`, zdarzenia lobby i wiadomości partii
w kształtach z sekcji 2 handoffu (`gameStart`, `gameFinish`, `challenge`, `challengeGone`, `full`, `state`,
`opponentGone`, `end`), plus `members` (kto online, rankingi).

- `ply` daje idempotencję: ruch wysłany ponownie po zerwaniu połączenia nie zostanie zagrany dwa razy.
- Zegar: startuje od 2. półruchu; po ruchu alarm na moment wyczerpania czasu strony na ruchu → `outoftime`.
  Czasy w `state` przeliczone na chwilę wysłania.
- Brak połączenia rywala 30 s → `opponentGone{claimWinInSeconds: 60}`.
- Bez pierwszego ruchu w 30 s (białe) / 30 s (czarne) → `noStart`, bez wpływu na ranking.

## Front

- `provider.features` steruje lobby; Lichess i demo bez zmian.
- Start: trzeci przycisk „Graj w pokoju (bez Lichess)” → utwórz pokój (nazwa + nick).
- `boot()`: `?pokoj=KOD` → dołącz (nick); `?przenies=KOD` → przejmij tożsamość; zapisany token → wejście od razu.
- Lobby pokoju: link + `navigator.share`, członkowie z kropką online, tabela rankingu wg tempa, historia,
  „Nowa partia” = wybór członka + presety (z blitzem) + kolor + rankingowa.
- `config.js`: `ROOMS_API`.

## Testy

`wrangler dev` + Playwright (widok mobilny, dwie osobne przeglądarki): kryteria 1–5 z handoffu,
`setOffline` na 20 s, ruch nielegalny wysłany z pominięciem UI, regresja Lichess (symulacja) i demo.

## Stan (30.10.2026)

Zbudowane i sprawdzone lokalnie: `serwer/` (8 testów serwera) i front (`rooms.js`, widoki w `app.js`,
`prywatnosc.html`; 3 testy Playwright: pełny przebieg B1 z 20 s bez sieci + regresja A i demo).
Wdrożone 30.10.2026: https://przy-szachownicy.przemmeq.workers.dev (`jurisdiction("eu")` działa na darmowym planie),
`ROOMS_API` ustawione w `config.js`. Do zrobienia: test na dwóch prawdziwych telefonach.

## Kolejność

1. `serwer/`: pokój, członkowie, tokeny, WebSocket, wyzwania (≈1 d)
2. Partia: legalność, zegar + alarmy, remis/poddanie/przerwanie/opuszczenie, Glicko-2 (≈1 d)
3. `rooms.js` + widoki w `app.js` (≈1,5 d)
4. Playwright + polityka prywatności + wdrożenie na workers.dev (≈1 d)

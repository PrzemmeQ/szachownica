// Przebiegi na „telefonach” (widok mobilny) z lokalnym serwerem: kluby z kodem, konta, wspólny ranking,
// znajomi, rewanż, wyjście rywala, cofanie, panel trenera/admina; regresja wariantu A (bez ROOMS_API).
import { test, expect } from '@playwright/test';
import { startServer } from '../test/helpers.mjs';
import { serveFront } from './static.mjs';

const API_PORT = 8799;
const FRONT = 'http://127.0.0.1:8080';
const FRONT_A = 'http://127.0.0.1:8081';
const PASS = 'haslo-testowe-1';
let api; let front; let frontA;

test.beforeAll(async () => {
  api = await startServer(API_PORT);
  front = await serveFront(8080, `http://127.0.0.1:${API_PORT}`);
  frontA = await serveFront(8081, ''); // jak wariant A: bez serwera
});
test.afterAll(async () => {
  front?.close(); frontA?.close();
  await api?.stop();
});

const uniq = (p) => p + Math.random().toString(36).slice(2, 6);

// Zapisuje teksty czytane na głos (window.__spoken).
async function phone(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    window.__spoken = [];
    if ('speechSynthesis' in window) {
      speechSynthesis.speak = (u) => { window.__spoken.push(u.text); };
      speechSynthesis.cancel = () => {};
    }
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

// Wpisuje ruch notacją (domyślny tryb) przyciskami, np. „e4”, „Nf3”, „exd5”, „O-O”.
async function typeSan(page, san) {
  const tokens = /^O-O(-O)?$/.test(san) ? [san] : san.split('');
  for (const t of tokens) await page.locator(`#entry button.key[data-action="san"][data-k="${t}"]`).click();
}
async function play(page, san) {
  await typeSan(page, san);
  await page.getByRole('button', { name: 'Wyślij ruch' }).click();
}
// Naprzemienne ruchy: W zaczyna; każdy ruch czeka, aż dotrze do drugiej strony.
async function playMoves(W, Bl, sans) {
  for (let i = 0; i < sans.length; i++) {
    const [me, other] = i % 2 === 0 ? [W, Bl] : [Bl, W];
    await play(me, sans[i]);
    await expect(other.locator('.lm-san')).toHaveText(sans[i]);
  }
}
const OPENING = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6']; // 10 półruchów — partia się liczy

function clockMs(text) {
  const m = text.trim().match(/^(\d+):(\d{2})(?:\.(\d))?$/);
  if (!m) throw new Error('zły zegar: ' + text);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3] || 0) * 100;
}
async function expectClocksAgree(pa, pb) {
  // zegar „mój” u A = zegar „rywala” u B (i odwrotnie), z tolerancją ±1 s
  const [aMe, aOpp, bMe, bOpp] = await Promise.all([
    pa.locator('#clock-me').textContent(), pa.locator('#clock-opp').textContent(),
    pb.locator('#clock-me').textContent(), pb.locator('#clock-opp').textContent(),
  ]);
  expect(Math.abs(clockMs(aMe) - clockMs(bOpp))).toBeLessThanOrEqual(1000);
  expect(Math.abs(clockMs(aOpp) - clockMs(bMe))).toBeLessThanOrEqual(1000);
}

// Konto przez „Szybka gra” → poczekalnia ogólna.
async function register(page, nick, email) {
  await page.goto(FRONT + '/');
  await page.getByRole('button', { name: /Szybka gra/ }).click();
  await page.locator('#room-nick').fill(nick);
  await page.locator('#acct-pass').fill(PASS);
  if (email) await page.locator('#acct-email').fill(email);
  await page.getByRole('button', { name: 'Załóż konto' }).click();
  await expect(page.locator('.who')).toContainText(nick);
}
// Zakłada klub z ekranu startowego; zwraca { code, link }.
async function createClub(page, name, nick) {
  await page.locator('button[data-action="room-new"]').first().click();
  await expect(page.getByRole('heading', { name: 'Nowy klub' })).toBeVisible();
  await page.locator('#room-name').fill(name);
  if (nick) await page.locator('#room-nick').fill(nick);
  await page.getByRole('button', { name: 'Załóż klub' }).click();
  await expect(page.getByRole('heading', { name: `Klub „${name}”` })).toBeVisible();
  const code = (await page.locator('#club-code-show').textContent()).trim();
  const link = await page.locator('#invite-link').inputValue();
  await page.getByRole('button', { name: 'Gotowe' }).click();
  return { code, link };
}
// Dołącza z linku ?klub=KOD (kod sprawdzany od razu).
async function joinByLink(page, link, nick, password) {
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Dołącz do klubu' })).toBeVisible();
  await expect(page.locator('#room-nick')).toBeVisible();
  if (nick) await page.locator('#room-nick').fill(nick);
  if (password) await page.locator('#club-pass').fill(password);
  await page.getByRole('button', { name: 'Dołącz' }).click();
}
// Wyzwanie w klubie: A wybiera rywala, A ma białe; B przyjmuje.
async function challengeWhite(A, B, oppNick, { preset, rated } = {}) {
  await A.locator('button.tab[data-action="mode"][data-id="member"]').click();
  await A.locator('button.chip[data-action="opponent"]', { hasText: oppNick }).click();
  if (preset) await A.locator(`button.chip[data-action="preset"][data-id="${preset}"]`).click();
  await A.locator('button.chip[data-action="color"][data-id="white"]').click();
  const box = A.locator('input[data-action="rated"]');
  if (rated != null && await box.isEnabled()) await box.setChecked(rated);
  await A.getByRole('button', { name: 'Wyślij wyzwanie' }).click();
  await B.getByRole('button', { name: 'Przyjmij' }).click();
  await expect(A.locator('.status')).toHaveText('Twój ruch');
}
async function resign(page) {
  await page.getByRole('button', { name: 'Poddaj' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Poddaj' }).click();
}

test('klub z kodem: błędny kod, dołączenie kontem, partia rankingowa 10+5, wyjście rywala z odliczaniem, wspólny ranking, Moje kluby', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  const nickA = uniq('Ania'); const nickB = uniq('Bart');

  // 1. A: konto, potem klub (nick z konta)
  await register(A.page, nickA);
  await A.page.getByRole('button', { name: 'Menu' }).click();
  const { code } = await createClub(A.page, 'Klub Hetman');
  expect(code).toMatch(/^KLUBH-[A-Z0-9]{5}$/);

  // 2. B: konto, „Dołącz do klubu” kodem — najpierw błędny
  await register(B.page, nickB);
  await B.page.getByRole('button', { name: 'Menu' }).click();
  await B.page.locator('button[data-action="club-join-open"]').first().click();
  await B.page.locator('#club-code').fill('KLUBH-00000');
  await B.page.getByRole('button', { name: 'Dalej' }).click();
  await expect(B.page.locator('.error')).toContainText('Pozostało prób');
  await B.page.locator('#club-code').fill(code.toLowerCase());
  await B.page.getByRole('button', { name: 'Dalej' }).click();
  await expect(B.page.getByText('Klub Klub Hetman')).toBeVisible();
  await expect(B.page.locator('#room-nick')).toHaveValue(nickB);
  await B.page.getByRole('button', { name: 'Dołącz' }).click();
  await expect(B.page.locator('.who')).toContainText('Klub Hetman');
  await expect(B.page.locator('.rank-list')).toContainText(nickA);

  // 3. partia rankingowa (oboje mają konto) — bez podpowiedzi
  await expect(A.page.locator('input[data-action="rated"]')).toBeEnabled();
  await challengeWhite(A.page, B.page, nickB, { preset: 'r10_5', rated: true });
  await expect(A.page.locator('.g-meta')).toContainText('Rapid 10+5 · rankingowa');
  await typeSan(A.page, 'N');
  await expect(A.page.locator('.entry-msg')).not.toContainText('Pasuje');
  await A.page.getByRole('button', { name: '⌫ Cofnij' }).click();
  await playMoves(A.page, B.page, OPENING.slice(0, 4));
  await expect.poll(() => A.page.evaluate(() => window.__spoken.at(-1))).toBe('Skoczek be 8 na ce 6');

  // 4. B traci sieć: u A wyraźny pasek, przyciski aktywne dopiero po odliczaniu; B wraca
  await B.ctx.setOffline(true);
  await expect(A.page.locator('.gone-bar')).toContainText('Rywal opuścił partię', { timeout: 25000 });
  await expect(A.page.locator('.gone-bar button[data-action="claim-win"]')).toBeEnabled({ timeout: 15000 });
  await expect(A.page.locator('.gone-bar')).toContainText('Możesz ogłosić wygraną albo remis');
  await B.page.waitForTimeout(3000);
  await B.ctx.setOffline(false);
  await expect(B.page.getByText('Brak połączenia')).toBeHidden({ timeout: 20000 });
  await expect(A.page.locator('.gone-bar')).toHaveCount(0, { timeout: 10000 });
  await expect(A.page.locator('#toast')).toContainText('Rywal wrócił');
  await expectClocksAgree(A.page, B.page);
  await playMoves(A.page, B.page, OPENING.slice(4));

  // 5. B się poddaje — zmiana rankingu na ekranie wyniku
  await resign(B.page);
  await expect(A.page.locator('.result-title')).toHaveText('Wygrana');
  await expect(A.page.locator('.rating-change')).toContainText('+');
  await expect(B.page.locator('.rating-change')).toContainText('-');

  // 6. wspólny ranking (start 1200): w klubie i w poczekalni ogólnej ta sama liczba
  await A.page.getByRole('button', { name: 'Wróć do listy partii' }).click();
  const rA = A.page.locator('.rank-row', { hasText: nickA }).locator('.rank-r');
  await expect(rA).toHaveText(/^\d{4}\?$/);
  const clubRating = parseInt(await rA.textContent(), 10);
  expect(clubRating).toBeGreaterThan(1200);
  await A.page.getByRole('button', { name: 'Menu' }).click();
  await A.page.getByRole('button', { name: /Szybka gra/ }).click();
  await expect(A.page.locator('.rank-row', { hasText: nickA }).locator('.rank-r')).toHaveText(`${clubRating}?`);

  // 7. po przeładowaniu B wraca do klubu; w menu „Moje kluby”
  await B.page.goto(FRONT + '/');
  await expect(B.page.locator('.who')).toContainText('Klub Hetman');
  await B.page.getByRole('button', { name: 'Menu' }).click();
  await expect(B.page.getByRole('heading', { name: 'Moje kluby' })).toBeVisible();
  await expect(B.page.locator('button[data-action="open-club"]')).toContainText('Klub Hetman');
  await A.ctx.close(); await B.ctx.close();
});

test('wariant A bez ROOMS_API: ekran startowy bez zmian, demo działa', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await page.goto(FRONT_A + '/');
  await expect(page.getByRole('button', { name: 'Zaloguj przez Lichess' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Dołącz do klubu/ })).toHaveCount(0);
  await expect(page.getByText('Grałbyś z rankingiem bez konta Lichess?')).toBeVisible();
  await page.getByRole('button', { name: 'Wypróbuj bez logowania' }).click();
  await expect(page.locator('.tabs .tab.sel')).toHaveText('Komputer');
  await page.locator('button.chip[data-action="color"][data-id="white"]').click();
  await page.getByRole('button', { name: 'Zagraj z komputerem' }).click();
  await play(page, 'd4');
  await expect(page.locator('.lm-san')).not.toHaveText('—', { timeout: 10000 });
  await ctx.close();
});

test('demo działa też, gdy kluby są włączone', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await page.goto(FRONT + '/');
  await expect(page.getByRole('button', { name: 'Zaloguj przez Lichess' })).toBeVisible();
  await page.getByRole('button', { name: 'Wypróbuj z komputerem (demo)' }).click();
  await page.getByRole('button', { name: 'Zagraj z komputerem' }).click();
  await expect(page.locator('.g-meta')).toBeVisible();
  await ctx.close();
});

test('poczekalnia ogólna: lista czekających, parowanie 10+0 i przycisk „Graj”; brak temp poniżej 10 minut', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  const nickA = uniq('Ola'); const nickB = uniq('Ewa');
  for (const [P, nick] of [[A, nickA], [B, nickB]]) {
    await register(P.page, nick);
    await expect(P.page.locator('.who')).toContainText('Poczekalnia ogólna');
    await expect(P.page.locator('.tabs .tab.sel').first()).toHaveText('Poczekalnia');
  }
  // tempa od 10 minut; nowe tempa turniejowe są
  await expect(A.page.locator('button.chip[data-action="preset"]', { hasText: '5+3' })).toHaveCount(0);
  for (const t of ['20+0', '45+15', '90+30']) await expect(A.page.locator('button.chip[data-action="preset"]', { hasText: t })).toHaveCount(1);

  await A.page.locator('button.chip[data-action="preset"][data-id="r10_0"]').click();
  await A.page.getByRole('button', { name: 'Szukaj rywala' }).click();
  await expect(A.page.getByText('Szukam rywala · Rapid 10+0')).toBeVisible();
  await expect(B.page.locator('.seek-list li', { hasText: nickA })).toContainText('Rapid 10+0');
  await B.page.locator('button.chip[data-action="preset"][data-id="r10_0"]').click();
  await B.page.getByRole('button', { name: 'Szukaj rywala' }).click();
  await expect(A.page.locator('.g-meta')).toContainText('Rapid 10+0');
  await expect(B.page.locator('.g-meta')).toContainText('Rapid 10+0');
  await expect(A.page.locator('.overlay')).toHaveCount(0);

  // przerwanie przed pierwszym ruchem, potem „Graj” przy czekającym (30+0)
  const aWhite = (await A.page.locator('.status').textContent()) === 'Twój ruch';
  const W = aWhite ? A.page : B.page;
  await W.getByRole('button', { name: 'Przerwij' }).click();
  await W.locator('.dialog').getByRole('button', { name: 'Przerwij' }).click();
  for (const P of [A, B]) await P.page.getByRole('button', { name: 'Wróć do listy partii' }).click();
  await A.page.locator('button.chip[data-action="preset"][data-id="c30_0"]').click();
  await A.page.getByRole('button', { name: 'Szukaj rywala' }).click();
  await B.page.locator('.seek-list li', { hasText: nickA }).getByRole('button', { name: 'Graj' }).click();
  await expect(A.page.locator('.g-meta')).toContainText('30+0');
  await expect(B.page.locator('.g-meta')).toContainText('30+0');
  await A.ctx.close(); await B.ctx.close();
});

test('znajomi: zaproszenie i akceptacja, wyzwanie znajomego, rewanż z potwierdzeniem, blokada', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  const nickA = uniq('Zosia'); const nickB = uniq('Tomek');
  await register(A.page, nickA);
  await register(B.page, nickB);

  // zakładka „Znajomi” zamiast listy wszystkich graczy online
  await A.page.locator('button.tab[data-action="mode"][data-id="member"]').click();
  await expect(A.page.locator('.note')).toContainText('Nikt ze znajomych');
  await A.page.locator('#friend-nick').fill(nickB);
  await A.page.getByRole('button', { name: 'Zaproś do znajomych' }).click();
  await expect(A.page.locator('.friends')).toContainText('Wysłane zaproszenia');
  await expect(B.page.locator('#toast')).toContainText(`${nickA} zaprasza Cię do znajomych`);
  await B.page.locator('.friend-row', { hasText: nickA }).getByRole('button', { name: 'Przyjmij' }).click();
  const rowB = A.page.locator('.friend-row', { hasText: nickB });
  await expect(rowB.locator('.dot.on')).toBeVisible();

  // wyzwanie znajomego z listy
  await rowB.getByRole('button', { name: 'Wyzwij' }).click();
  await B.page.getByRole('button', { name: 'Przyjmij' }).click();
  await expect(A.page.locator('.g-meta')).toBeVisible();
  await expect(B.page.locator('.g-meta')).toBeVisible();
  const aWhite = (await A.page.locator('.status').textContent()) === 'Twój ruch';
  const [W, Bl] = aWhite ? [A.page, B.page] : [B.page, A.page];
  await play(W, 'e4');
  await expect(Bl.locator('.lm-san')).toHaveText('e4');
  await resign(W);
  await expect(Bl.locator('.result-title')).toHaveText('Wygrana');
  await expect(Bl.locator('.result')).toContainText('Ranking bez zmian'); // poddanie przed 5. ruchem się nie liczy

  // rewanż: u rywala przycisk miga i pyta o potwierdzenie
  await Bl.getByRole('button', { name: 'Rewanż' }).click();
  await expect(W.locator('.rematch-note')).toContainText('proponuje rewanż');
  await expect(W.locator('button.pulse[data-action="rematch"]')).toBeVisible();
  await W.locator('button[data-action="rematch"]').click();
  await expect(W.getByRole('heading', { name: 'Przyjąć rewanż?' })).toBeVisible();
  await W.getByRole('button', { name: 'Tak, gramy' }).click();
  await expect(Bl.locator('.status')).toHaveText('Twój ruch'); // kolory zamienione
  await expect(W.locator('.player.me')).toContainText('czarne');
  await Bl.getByRole('button', { name: 'Przerwij' }).click();
  await Bl.locator('.dialog').getByRole('button', { name: 'Przerwij' }).click();
  for (const P of [A, B]) await P.page.getByRole('button', { name: 'Wróć do listy partii' }).click();

  // blokada: znika ze znajomych u obojga
  await B.page.locator('.friend-row', { hasText: nickA }).getByRole('button', { name: '⋯' }).click();
  await B.page.locator('.dialog').getByRole('button', { name: 'Zablokuj' }).click();
  await expect(B.page.locator('details.blocked summary')).toContainText('Zablokowani (1)');
  await expect(A.page.locator('.friend-row', { hasText: nickB })).toHaveCount(0);
  await A.ctx.close(); await B.ctx.close();
});

test('Menu główne: z Lichess do poczekalni i z powrotem, bez wylogowania', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  // konto Lichess udawane (bez sieci do lichess.org)
  await ctx.addInitScript(() => { if (!localStorage.getItem('ps_lichess_token')) localStorage.setItem('ps_lichess_token', 'lip_test'); });
  await ctx.route('https://lichess.org/**', (route) => {
    const u = route.request().url();
    if (u.includes('/api/account/playing')) return route.fulfill({ json: { nowPlaying: [] } });
    if (u.includes('/api/account')) return route.fulfill({ json: { id: 'tester', username: 'Tester', perfs: { rapid: { rating: 1600 } } } });
    if (u.includes('/api/stream/event')) return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '' });
    return route.fulfill({ status: 404, body: '' });
  });

  await page.goto(FRONT + '/');
  await expect(page.locator('.who')).toHaveText('Tester');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('button', { name: 'Graj przez Lichess' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Graj przez Lichess' })).toBeVisible();

  const nick = uniq('Lic');
  await page.getByRole('button', { name: /Szybka gra/ }).click();
  await page.locator('#room-nick').fill(nick);
  await page.locator('#acct-pass').fill(PASS);
  await page.getByRole('button', { name: 'Załóż konto' }).click();
  await expect(page.locator('.who')).toContainText('Poczekalnia ogólna');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.account-line')).toContainText('Grasz jako ' + nick);
  await page.getByRole('button', { name: 'Graj przez Lichess' }).click();
  await expect(page.locator('.who')).toHaveText('Tester');
  await ctx.close();
});

// Uwaga: page.reload() w Chromium bierze moduły z pamięci karty z pominięciem service workera,
// dlatego „ponowne otwarcie aplikacji” = nowa karta (tak jak na telefonie).
test('aktualizacja: po ponownym otwarciu nowa wersja mimo pamięci jak na GitHub Pages; działa bez sieci', async ({ browser }) => {
  let name = 'Wersja Jeden';
  const pages = await serveFront(8083, '', { pages: true, appName: () => name });
  const open = async (ctx) => { const p = await ctx.newPage(); await p.goto('http://127.0.0.1:8083/'); return p; };
  try {
    const ctx = await browser.newContext();
    let page = await open(ctx);
    await expect(page.locator('h1')).toHaveText('Wersja Jeden');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.close();
    page = await open(ctx);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.close();

    name = 'Wersja Dwa';
    page = await open(ctx);
    await expect(page.locator('h1')).toHaveText('Wersja Dwa');
    await page.close();

    await ctx.setOffline(true);
    page = await open(ctx);
    await expect(page.locator('h1')).toHaveText('Wersja Dwa');
    await ctx.close();
  } finally {
    pages.close();
  }
});

test('konto: formularz z zapisem hasła, klub na koncie, logowanie na nowym telefonie, 6-cyfrowy kod przeniesienia', async ({ browser }) => {
  const nick = uniq('Kon');
  const A = await phone(browser);
  await A.page.goto(FRONT + '/');
  await expect(A.page.getByRole('heading', { name: 'Bez konta Lichess' })).toBeVisible();
  await A.page.getByRole('button', { name: /Szybka gra/ }).click();
  await expect(A.page.getByRole('heading', { name: 'Załóż konto' })).toBeVisible();
  // prawdziwy <form> z polami username/password (Pęk kluczy na iPhonie)
  await expect(A.page.locator('form[data-form="account"] input[autocomplete="username"]')).toHaveCount(1);
  await expect(A.page.locator('form[data-form="account"] input[type="password"][autocomplete="new-password"]')).toHaveCount(1);
  await A.page.locator('#room-nick').fill(nick);
  await A.page.locator('#acct-pass').fill('krotkie');
  await A.page.locator('#acct-pass').press('Enter');
  await expect(A.page.locator('#toast')).toContainText('co najmniej 8');
  await A.page.locator('#acct-pass').fill('moje-haslo-123');
  await A.page.locator('#acct-email').fill(nick + '@example.com');
  await A.page.getByRole('button', { name: 'Załóż konto' }).click();
  await expect(A.page.locator('.who')).toContainText(nick);

  // klub na koncie
  await A.page.getByRole('button', { name: 'Menu' }).click();
  await expect(A.page.locator('.account-line')).toContainText('Grasz jako ' + nick);
  await A.page.locator('button[data-action="room-new"]').first().click();
  await expect(A.page.locator('#room-nick')).toHaveValue(nick);
  await A.page.locator('#room-name').fill('Klub konta');
  await A.page.getByRole('button', { name: 'Załóż klub' }).click();
  await expect(A.page.getByRole('heading', { name: 'Klub „Klub konta”' })).toBeVisible();

  // kod przeniesienia (6 cyfr) → telefon bez konta
  await A.page.getByRole('button', { name: 'Utwórz kod przeniesienia' }).click();
  await expect(A.page.locator('.dialog .club-code')).toHaveCount(2); // kod klubu + kod przeniesienia
  const code6 = (await A.page.locator('.dialog .club-code').last().textContent()).replace(/\D/g, '');
  expect(code6).toMatch(/^\d{6}$/);
  const D = await phone(browser);
  await D.page.goto(FRONT + '/');
  await D.page.getByText('Mam kod przeniesienia').click();
  await D.page.locator('#transfer-code').fill('000000');
  await D.page.getByRole('button', { name: 'Przenieś' }).click();
  await expect(D.page.locator('#toast')).toContainText('Kod przeniesienia jest zły');
  await D.page.locator('#transfer-code').fill(code6.slice(0, 3) + ' ' + code6.slice(3));
  await D.page.getByRole('button', { name: 'Przenieś' }).click();
  await expect(D.page.locator('.who')).toContainText(nick);
  await expect(D.page.locator('.who')).toContainText('Klub konta');
  await A.ctx.close(); await D.ctx.close();

  // nowy telefon: logowanie → „Moje kluby” z klubem z konta
  const C = await phone(browser);
  await C.page.goto(FRONT + '/');
  await C.page.getByRole('button', { name: 'Mam konto — zaloguj się' }).click();
  await C.page.locator('#room-nick').fill(nick.toLowerCase());
  await C.page.locator('#acct-pass').fill('zle-haslo-000');
  await C.page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(C.page.locator('#toast')).toContainText('Nieprawidłowy nick lub hasło');
  await C.page.locator('#acct-pass').fill('moje-haslo-123');
  await C.page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(C.page.locator('.account-line')).toContainText('Grasz jako ' + nick);
  const club = C.page.locator('button[data-action="open-club"]', { hasText: 'Klub konta' });
  await expect(club).toContainText('zapisany na koncie');
  await club.click();
  await expect(C.page.locator('.who')).toContainText('Klub konta');

  // konto: wylogowanie i „nie pamiętam hasła”
  await C.page.getByRole('button', { name: 'Menu' }).click();
  await C.page.getByRole('button', { name: /Szybka gra/ }).click();
  await C.page.locator('button[aria-label="Konto"]').click();
  await expect(C.page.getByRole('heading', { name: 'Twoje konto' })).toBeVisible();
  await expect(C.page.locator('.dialog')).toContainText(nick + '@example.com');
  await C.page.getByRole('button', { name: 'Wyloguj z tego urządzenia' }).click();
  await C.page.locator('.dialog').getByRole('button', { name: 'Wyloguj' }).click();
  await C.page.getByRole('button', { name: 'Mam konto — zaloguj się' }).click();
  await C.page.getByRole('button', { name: 'Nie pamiętam hasła' }).click();
  await C.page.locator('#acct-login').fill(nick);
  await C.page.getByRole('button', { name: 'Wyślij link' }).click();
  await expect(C.page.locator('.note')).toContainText('nie jest jeszcze włączone');
  await C.ctx.close();
});

test('wpisywanie notacją: bez podpowiedzi domyślnie, tryb nauki w towarzyskiej, Nbd2, polskie litery, „skąd → dokąd”', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  await A.page.goto(FRONT + '/');
  const { link } = await createClub(A.page, 'Notacja', 'Biały');
  await joinByLink(B.page, link, 'Czarny');
  await expect(A.page.locator('input[data-action="rated"]')).toBeDisabled(); // bez kont tylko towarzyskie
  await challengeWhite(A.page, B.page, 'Czarny');
  const W = A.page; const Bl = B.page;

  // domyślnie bez podpowiedzi
  await typeSan(W, 'N');
  await expect(W.locator('.entry-msg')).not.toContainText('Pasuje');
  await W.locator('.g-top button[data-action="game-menu"]').click();
  await W.getByRole('button', { name: 'Ustawienia' }).click();
  await W.locator('input[data-key="learnMode"]').check();
  await W.getByRole('button', { name: 'Gotowe' }).click();

  // tryb nauki: podpowiedzi i opis gotowego ruchu
  await typeSan(W, 'N');
  await expect(W.locator('.entry-msg')).toContainText('Pasuje:');
  await expect(W.locator('.entry-msg')).toContainText('Nf3');
  await typeSan(W, 'f3');
  await expect(W.locator('.san-box')).toHaveText('Nf3');
  await expect(W.locator('.entry-msg')).toContainText('skoczek g1 → f3');
  await W.getByRole('button', { name: 'Wyślij ruch' }).click();
  await expect(Bl.locator('.lm-san')).toHaveText('Nf3');
  await play(Bl, 'd5');
  await expect(W.locator('.lm-san')).toHaveText('d5');

  await typeSan(W, 'e6');
  await expect(W.locator('.entry-msg')).toContainText('Nie ma takiego ruchu');
  await expect(W.getByRole('button', { name: 'Wyślij ruch' })).toBeDisabled();
  await W.getByRole('button', { name: '⌫ Cofnij' }).click();
  await W.getByRole('button', { name: '⌫ Cofnij' }).click();
  await playMoves(W, Bl, ['d4', 'e6']);

  await typeSan(W, 'Nd2');
  await expect(W.locator('.entry-msg')).toContainText('Nbd2');
  await expect(W.locator('.entry-msg')).toContainText('Nfd2');
  await expect(W.getByRole('button', { name: 'Wyślij ruch' })).toBeDisabled();
  for (let i = 0; i < 3; i++) await W.getByRole('button', { name: '⌫ Cofnij' }).click();
  await play(W, 'Nbd2');
  await expect(Bl.locator('.lm-san')).toHaveText('Nbd2');

  // bez trybu nauki: zły ruch dopiero po „Wyślij”, ogólny komunikat
  await play(Bl, 'c6');
  await expect(W.locator('.lm-san')).toHaveText('c6');
  // polskie litery figur
  await Bl.locator('.g-top button[data-action="game-menu"]').click();
  await Bl.getByRole('button', { name: 'Ustawienia' }).click();
  await Bl.locator('input[data-key="englishNotation"]').uncheck();
  await Bl.getByRole('button', { name: 'Gotowe' }).click();
  await play(W, 'e3');
  await expect(Bl.locator('.lm-san')).toHaveText('e3');
  await typeSan(Bl, 'c4');
  await expect(Bl.locator('.entry-msg')).not.toContainText('Nie ma takiego ruchu');
  await Bl.getByRole('button', { name: '⌫ Cofnij' }).click();
  await Bl.getByRole('button', { name: '⌫ Cofnij' }).click();
  await expect(Bl.locator('#entry button.key.piece[data-k="N"]')).toContainText('S');

  // tryb „skąd → dokąd”
  await Bl.getByRole('button', { name: /przełącz na „skąd → dokąd”/ }).click();
  await expect(Bl.locator('.slots .slot')).toHaveCount(4);
  for (const ch of 'c6c5') await Bl.locator(`#entry button.key[data-k="${ch}"]`).click();
  await Bl.getByRole('button', { name: 'Wyślij ruch' }).click();
  await expect(W.locator('.lm-san')).toHaveText('c5');
  await A.ctx.close(); await B.ctx.close();
});

test('cofnięcie ruchu: komunikat o odmowie, limit próśb, zgoda; strona statystyk z kluczem', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  await A.page.goto(FRONT + '/');
  const { link } = await createClub(A.page, 'Klub cofania', 'Ala');
  await joinByLink(B.page, link, 'Olek');
  await challengeWhite(A.page, B.page, 'Olek');
  const W = A.page; const Bl = B.page;
  await playMoves(W, Bl, ['e4', 'e5', 'Nc3']); // pomyłka: chciał Nf3

  const ask = async () => {
    await W.getByRole('button', { name: 'Cofnij mój ruch' }).click();
    await W.locator('.dialog').getByRole('button', { name: 'Poproś' }).click();
    await expect(W.getByText('czekam na zgodę rywala')).toBeVisible();
    await expect(Bl.getByText('Rywal prosi o cofnięcie')).toBeVisible();
  };
  // dwie odmowy dla tego samego ruchu — za każdym razem komunikat
  for (let i = 0; i < 2; i++) {
    await ask();
    await Bl.getByRole('button', { name: 'Odmów' }).click();
    await expect(W.locator('#toast')).toContainText('Rywal odmówił cofnięcia ruchu');
    await expect(W.getByText('czekam na zgodę rywala')).toBeHidden();
  }
  // po dwóch odmowach: o ten ruch już nie można prosić; po kolejnym ruchu znowu raz
  await expect(W.getByRole('button', { name: 'Cofnij mój ruch' })).toHaveCount(0);
  await play(Bl, 'Nc6');
  await expect(W.locator('.lm-san')).toHaveText('Nc6');
  await ask();
  await Bl.getByRole('button', { name: 'Zgódź się' }).click();
  await expect(W.locator('.entry-msg')).toContainText('Cofnięto');
  await expect(W.locator('.status')).toHaveText('Twój ruch');
  await expect(Bl.locator('.lm-san')).toHaveText('e4');
  await play(W, 'Nf3');
  await expect(Bl.locator('.lm-san')).toHaveText('Nf3');

  // prośba wygasa, gdy rywal zagra
  await ask();
  await play(Bl, 'Nc6');
  await expect(W.locator('#toast')).toContainText('wygasła — rywal zagrał');

  await resign(Bl);
  await expect(W.locator('.result-title')).toHaveText('Wygrana');
  const S = await phone(browser);
  await S.page.goto(FRONT + '/statystyki.html');
  await S.page.locator('#key').fill('zly-klucz');
  await S.page.getByRole('button', { name: 'Pokaż' }).click();
  await expect(S.page.locator('#err')).toContainText('Zły klucz');
  await S.page.locator('#key').fill('klucz-testowy-statystyk');
  await S.page.getByRole('button', { name: 'Pokaż' }).click();
  await expect(S.page.getByRole('heading', { name: 'Czy pomysł działa?' })).toBeVisible();
  await expect(S.page.locator('table').first()).toContainText('Klub cofania');
  await A.ctx.close(); await B.ctx.close(); await S.ctx.close();
});

test('panel trenera: hasło klubu, admin, podgląd na żywo, PGN, usuwanie członka; strona dla klubów', async ({ browser }) => {
  const T = await phone(browser);
  await T.page.goto(FRONT + '/kluby.html');
  await expect(T.page.getByRole('heading', { level: 1 })).toContainText('prawdziwej szachownicy');
  await T.page.getByRole('link', { name: 'Załóż klub' }).first().click();
  await expect(T.page.getByRole('heading', { name: 'Nowy klub' })).toBeVisible();
  await T.page.locator('#room-name').fill('Szkółka Gambit');
  await T.page.locator('#room-nick').fill('Trener');
  await T.page.getByRole('button', { name: 'Załóż klub' }).click();
  const code = (await T.page.locator('#club-code-show').textContent()).trim();
  expect(code).toMatch(/^SZKOL-[A-Z0-9]{5}$/); // polskie litery bez ogonków
  const link = await T.page.locator('#invite-link').inputValue();

  // hasło klubu oprócz kodu
  await T.page.getByRole('button', { name: 'Ustaw hasło klubu' }).click();
  await T.page.locator('#prompt-input').fill('gambit1');
  await T.page.locator('.dialog').getByRole('button', { name: 'Zapisz' }).click();
  await expect(T.page.locator('#toast')).toContainText('Ustawiono hasło klubu');
  await expect(T.page.getByRole('button', { name: 'Zmień lub usuń hasło klubu' })).toBeVisible();
  await T.page.getByRole('button', { name: 'Gotowe' }).click();
  await expect(T.page.getByRole('button', { name: 'Otwórz panel trenera' })).toBeVisible();

  const A = await phone(browser);
  const B = await phone(browser);
  await joinByLink(A.page, link, 'Ala', 'zle-haslo');
  await expect(A.page.locator('.error')).toContainText('Pozostało prób');
  await A.page.locator('#club-pass').fill('gambit1');
  await A.page.getByRole('button', { name: 'Dołącz' }).click();
  await joinByLink(B.page, link, 'Bob', 'gambit1');
  for (const P of [A, B]) {
    await expect(P.page.locator('.who')).toContainText('Szkółka Gambit');
    await expect(P.page.getByRole('button', { name: 'Otwórz panel trenera' })).toHaveCount(0);
  }

  // założyciel mianuje Alę adminem → Ala widzi panel
  await T.page.getByRole('button', { name: 'Otwórz panel trenera' }).click();
  await T.page.locator('.coach-table tr', { hasText: 'Ala' }).getByRole('button', { name: 'zrób adminem' }).click();
  await expect(T.page.locator('.coach-table tr', { hasText: 'Ala' })).toContainText('admin');
  await expect(A.page.getByRole('button', { name: 'Otwórz panel trenera' })).toBeVisible();

  // partia Ala–Bob, trener ogląda na żywo
  await challengeWhite(A.page, B.page, 'Bob');
  await play(A.page, 'e4');
  await expect(B.page.locator('.lm-san')).toHaveText('e4');
  await T.page.locator('button[data-action="coach-refresh"]').click();
  await T.page.locator('.row', { hasText: 'Ala – Bob' }).click();
  await expect(T.page.locator('.status')).toContainText('Podgląd trenera');
  await expect(T.page.locator('.mini-board')).toBeVisible();
  await expect(T.page.locator('#entry button.key')).toHaveCount(0);
  await play(B.page, 'e5');
  await expect(T.page.locator('.lm-san')).toHaveText('e5');
  await resign(B.page);
  await expect(A.page.locator('.result-title')).toHaveText('Wygrana');

  // wyniki graczy i PGN
  await T.page.getByRole('button', { name: '← Partie' }).click();
  await T.page.locator('button[data-action="coach-refresh"]').click();
  await expect(T.page.locator('.coach-table tr', { hasText: 'Ala' })).toContainText('1');
  const [dl] = await Promise.all([
    T.page.waitForEvent('download'),
    T.page.getByRole('button', { name: 'Pobierz wszystkie partie (PGN)' }).click(),
  ]);
  const pgn = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
  expect(pgn).toContain('[White "Ala"]');
  expect(pgn).toContain('1. e4 e5');

  // admin usuwa Boba → Bob wraca do ekranu startowego z komunikatem
  await A.page.getByRole('button', { name: 'Wróć do listy partii' }).click();
  await A.page.getByRole('button', { name: 'Otwórz panel trenera' }).click();
  await expect(A.page.locator('.coach-table tr', { hasText: 'Trener' }).getByRole('button', { name: 'usuń' })).toHaveCount(0);
  await A.page.locator('.coach-table tr', { hasText: 'Bob' }).getByRole('button', { name: 'usuń' }).click();
  await A.page.locator('.dialog').getByRole('button', { name: 'Usuń' }).click();
  await expect(B.page.locator('#toast')).toContainText('usunięty z tego klubu');
  await expect(B.page.getByRole('button', { name: /Szybka gra/ })).toBeVisible();
  await expect(A.page.locator('.coach-table tr', { hasText: 'Bob' })).toHaveCount(0);

  // zmiana kodu: stary kod przestaje działać
  await T.page.getByRole('button', { name: '← Klub' }).click();
  await T.page.locator('button[data-action="room-menu"]').first().click();
  await T.page.getByRole('button', { name: 'Zmień kod' }).click();
  await T.page.locator('.dialog').getByRole('button', { name: 'Zmień kod' }).click();
  await expect(T.page.locator('#club-code-show')).not.toHaveText(code);
  const C = await phone(browser);
  await C.page.goto(link);
  await expect(C.page.locator('.error')).toContainText('Nie ma klubu o takim kodzie');
  for (const P of [T, A, B, C]) await P.ctx.close();
});

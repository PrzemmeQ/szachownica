// Przebieg B1 na dwóch „telefonach” (widok mobilny) z lokalnym serwerem pokoi
// oraz regresja: bez ROOMS_API aplikacja wygląda i działa jak wariant A.
import { test, expect } from '@playwright/test';
import { startServer } from '../test/helpers.mjs';
import { serveFront } from './static.mjs';

const API_PORT = 8799;
const FRONT = 'http://127.0.0.1:8080';
const FRONT_A = 'http://127.0.0.1:8081';
let api; let front; let frontA;

test.beforeAll(async () => {
  api = await startServer(API_PORT);
  front = await serveFront(8080, `http://127.0.0.1:${API_PORT}`);
  frontA = await serveFront(8081, ''); // jak wariant A: bez serwera pokoi
});
test.afterAll(async () => {
  front?.close(); frontA?.close();
  await api?.stop();
});

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

test('B1: pokój z linku, wyzwanie 10+5, partia, zerwanie sieci na 20 s, ranking i historia', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);

  // 1. A tworzy pokój
  await A.page.goto(FRONT + '/');
  await A.page.getByRole('button', { name: /Pokój ze znajomymi/ }).click();
  await A.page.locator('#room-name').fill('Klub Hetman');
  await A.page.locator('#room-nick').fill('Ania');
  await A.page.getByRole('button', { name: 'Utwórz pokój' }).click();
  await expect(A.page.getByRole('heading', { name: 'Pokój „Klub Hetman”' })).toBeVisible();
  const invite = await A.page.locator('#invite-link').inputValue();
  expect(invite).toMatch(/\?pokoj=[a-z2-9]{12}$/);
  await A.page.getByRole('button', { name: 'Gotowe' }).click();

  // 2. B dołącza samym nickiem
  await B.page.goto(invite);
  await expect(B.page.getByText('Zaproszenie do pokoju')).toContainText('Klub Hetman');
  await B.page.locator('#room-nick').fill('Bartek');
  await B.page.getByRole('button', { name: 'Dołącz' }).click();
  await expect(B.page.locator('.who')).toContainText('Bartek');
  await expect(B.page.locator('.rank-list')).toContainText('Ania');

  // 3. A wyzywa B: 10+5, białymi
  await A.page.locator('button.tab[data-action="mode"][data-id="member"]').click();
  await expect(A.page.locator('button.chip[data-action="opponent"]')).toContainText('Bartek');
  await A.page.locator('button.chip[data-action="preset"][data-id="r10_5"]').click();
  await A.page.locator('button.chip[data-action="color"][data-id="white"]').click();
  await A.page.getByRole('button', { name: 'Wyślij wyzwanie' }).click();
  await expect(A.page.getByText('Czekam, aż Bartek przyjmie wyzwanie')).toBeVisible();

  // 4. B przyjmuje — obie strony w partii
  await B.page.getByRole('button', { name: 'Przyjmij' }).click();
  await expect(A.page.locator('.g-meta')).toContainText('Rapid 10+5 · rankingowa');
  await expect(B.page.locator('.g-meta')).toContainText('Rapid 10+5 · rankingowa');

  // 5. ruchy w obie strony, ruch rywala na ekranie i czytany na głos
  await expect(A.page.locator('.status')).toHaveText('Twój ruch');
  await play(A.page, 'e4');
  await expect(B.page.locator('.lm-san')).toHaveText('e4');
  await expect.poll(() => B.page.evaluate(() => window.__spoken.at(-1))).toBe('Pion e 2 na e 4');
  await play(B.page, 'e5');
  await expect(A.page.locator('.lm-san')).toHaveText('e5');
  await expect.poll(() => A.page.evaluate(() => window.__spoken.at(-1))).toBe('Pion e 7 na e 5');
  await play(A.page, 'Nf3');
  await expect(B.page.locator('.lm-san')).toHaveText('Nf3');
  await B.page.waitForTimeout(1500);
  await expectClocksAgree(A.page, B.page);

  // 6. B traci internet na 20 s; zegar czarnych biegnie dalej na serwerze
  await B.ctx.setOffline(true);
  await expect(B.page.getByText('Brak połączenia')).toBeVisible({ timeout: 25000 });
  await expect(A.page.getByText('Rywal opuścił partię')).toBeVisible({ timeout: 25000 });
  await B.page.waitForTimeout(20000);
  await B.ctx.setOffline(false);
  await expect(B.page.getByText('Brak połączenia')).toBeHidden({ timeout: 20000 });
  await expect(A.page.getByText('Rywal opuścił partię')).toBeHidden({ timeout: 10000 });
  await expectClocksAgree(A.page, B.page);
  const bTime = clockMs(await B.page.locator('#clock-me').textContent());
  expect(bTime).toBeLessThan(600000 - 20000); // czas w trakcie zerwania został policzony
  await play(B.page, 'Nc6');
  await expect(A.page.locator('.lm-san')).toHaveText('Nc6');
  await expectClocksAgree(A.page, B.page);

  // 7. B się poddaje
  await B.page.getByRole('button', { name: 'Poddaj' }).click();
  await B.page.locator('.dialog').getByRole('button', { name: 'Poddaj' }).click();
  await expect(A.page.locator('.result-title')).toHaveText('Wygrana');
  await expect(B.page.locator('.result-title')).toHaveText('Przegrana');

  // 8. ranking pokoju (rapid) i historia
  await A.page.getByRole('button', { name: 'Wróć do listy partii' }).click();
  const aRow = A.page.locator('.rank-row', { hasText: 'Ania' });
  await expect(aRow.locator('.rank-r')).toHaveText(/^1[6-7]\d\d\?$/);
  await expect(A.page.locator('.rank-row', { hasText: 'Bartek' }).locator('.rank-r')).toHaveText(/^1[3-4]\d\d\?$/);
  await expect(A.page.locator('.who + .small')).toContainText('Rapid');
  await A.page.locator('details.room-hist summary').click();
  const hist = A.page.locator('.hist-list li').first();
  await expect(hist).toContainText('Ania');
  await expect(hist).toContainText('1–0');
  await expect(hist).toContainText('Poddanie');
  // klasyczne osobno: tam nadal brak rankingu
  await A.page.locator('button.tab[data-action="rank-speed"][data-id="classical"]').click();
  await expect(aRow.locator('.rank-r')).toHaveText('—');

  // 9. po przeładowaniu urządzenie pamięta pokój
  await B.page.goto(FRONT + '/');
  await expect(B.page.locator('.who')).toContainText('Bartek');

  await A.ctx.close(); await B.ctx.close();
});

test('wariant A bez ROOMS_API: ekran startowy bez zmian, demo działa', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await page.goto(FRONT_A + '/');
  await expect(page.getByRole('button', { name: 'Zaloguj przez Lichess' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Graj w pokoju (bez Lichess)' })).toHaveCount(0);
  await expect(page.getByText('Grałbyś z rankingiem bez konta Lichess?')).toBeVisible();
  await page.getByRole('button', { name: 'Wypróbuj bez logowania' }).click();
  await expect(page.locator('.tabs .tab.sel')).toHaveText('Komputer');
  await page.locator('button.chip[data-action="color"][data-id="white"]').click();
  await page.getByRole('button', { name: 'Zagraj z komputerem' }).click();
  await play(page, 'd4');
  await expect(page.locator('.lm-san')).not.toHaveText('—', { timeout: 10000 });
  await ctx.close();
});

test('demo działa też, gdy pokoje są włączone', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await page.goto(FRONT + '/');
  await expect(page.getByRole('button', { name: 'Zaloguj przez Lichess' })).toBeVisible();
  await page.getByRole('button', { name: 'Wypróbuj z komputerem (demo)' }).click();
  await page.getByRole('button', { name: 'Zagraj z komputerem' }).click();
  await expect(page.locator('.g-meta')).toBeVisible();
  await ctx.close();
});

test('poczekalnia ogólna: lista czekających i automatyczne parowanie (10+0); brak temp poniżej 10 minut', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  const nickA = 'Ola' + Math.random().toString(36).slice(2, 6);
  const nickB = 'Ewa' + Math.random().toString(36).slice(2, 6);

  for (const [P, nick] of [[A, nickA], [B, nickB]]) {
    await P.page.goto(FRONT + '/');
    await P.page.getByRole('button', { name: /Szybka gra/ }).click();
    await P.page.locator('#room-nick').fill(nick);
    await P.page.locator('#acct-pass').fill('haslo-testowe-1');
    await P.page.getByRole('button', { name: 'Załóż konto' }).click();
    await expect(P.page.locator('.who')).toContainText(nick);
    await expect(P.page.locator('.who')).toContainText('Poczekalnia ogólna');
    await expect(P.page.locator('.tabs .tab.sel').first()).toHaveText('Poczekalnia');
  }

  // tempa od 10 minut: nie ma 3+2 ani 5+3
  await expect(A.page.locator('button.chip[data-action="preset"]', { hasText: '3+2' })).toHaveCount(0);
  await expect(A.page.locator('button.chip[data-action="preset"]', { hasText: '5+3' })).toHaveCount(0);
  await A.page.locator('button.chip[data-action="preset"][data-id="r10_0"]').click();
  await A.page.getByRole('button', { name: 'Szukaj rywala' }).click();
  await expect(A.page.getByText('Szukam rywala · Rapid 10+0')).toBeVisible();

  // B widzi A na liście czekających
  const row = B.page.locator('.seek-list li', { hasText: nickA });
  await expect(row).toContainText('Rapid 10+0');

  // B wybiera to samo tempo i szuka → para od razu
  await B.page.locator('button.chip[data-action="preset"][data-id="r10_0"]').click();
  await B.page.getByRole('button', { name: 'Szukaj rywala' }).click();
  await expect(A.page.locator('.g-meta')).toContainText('Rapid 10+0');
  await expect(B.page.locator('.g-meta')).toContainText('Rapid 10+0');
  await expect(A.page.locator('.overlay')).toHaveCount(0);
  await expect(B.page.locator('.overlay')).toHaveCount(0);

  // kto ma białe, ten zaczyna
  const aWhite = (await A.page.locator('.status').textContent()) === 'Twój ruch';
  const W = aWhite ? A.page : B.page;
  const Bl = aWhite ? B.page : A.page;
  await play(W, 'd4');
  await expect(Bl.locator('.lm-san')).toHaveText('d4');
  await play(Bl, 'Nf6');
  await expect(W.locator('.lm-san')).toHaveText('Nf6');
  await W.getByRole('button', { name: 'Poddaj' }).click();
  await W.locator('.dialog').getByRole('button', { name: 'Poddaj' }).click();
  await expect(Bl.locator('.result-title')).toHaveText('Wygrana');

  // ranking ogólny (rapid) i własna historia
  await Bl.getByRole('button', { name: 'Wróć do listy partii' }).click();
  await expect(Bl.getByRole('heading', { name: 'Ranking ogólny' })).toBeVisible();
  await Bl.locator('details.room-hist summary').click();
  await expect(Bl.locator('.hist-list li').first()).toContainText('Rapid 10+0');

  await A.ctx.close(); await B.ctx.close();
});

test('poczekalnia: dołączenie przyciskiem „Graj” przy czekającym', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  const nickA = 'Jan' + Math.random().toString(36).slice(2, 6);
  for (const [P, nick] of [[A, nickA], [B, 'Iza' + Math.random().toString(36).slice(2, 6)]]) {
    await P.page.goto(FRONT + '/');
    await P.page.getByRole('button', { name: /Szybka gra/ }).click();
    await P.page.locator('#room-nick').fill(nick);
    await P.page.locator('#acct-pass').fill('haslo-testowe-1');
    await P.page.getByRole('button', { name: 'Załóż konto' }).click();
  }
  await A.page.locator('button.chip[data-action="preset"][data-id="c30_0"]').click();
  await A.page.getByRole('button', { name: 'Szukaj rywala' }).click();
  await B.page.locator('.seek-list li', { hasText: nickA }).getByRole('button', { name: 'Graj' }).click();
  await expect(A.page.locator('.g-meta')).toContainText('30+0');
  await expect(B.page.locator('.g-meta')).toContainText('30+0');
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

  // z tokenem i bez wcześniejszego wyboru: od razu Lichess (jak dotąd)
  await page.goto(FRONT + '/');
  await expect(page.locator('.who')).toHaveText('Tester');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('button', { name: 'Graj przez Lichess' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Szybka gra/ })).toBeVisible();

  // po przeładowaniu zostaje menu (nie wraca samo do Lichess)
  await page.reload();
  await expect(page.getByRole('button', { name: 'Graj przez Lichess' })).toBeVisible();

  // poczekalnia ogólna, potem Menu
  await page.getByRole('button', { name: /Szybka gra/ }).click();
  await page.locator('#room-nick').fill('Lic' + Math.random().toString(36).slice(2, 6));
  await page.locator('#acct-pass').fill('haslo-testowe-1');
  await page.getByRole('button', { name: 'Załóż konto' }).click();
  await expect(page.locator('.who')).toContainText('Poczekalnia ogólna');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.account-line')).toContainText('Grasz jako Lic');

  // z powrotem do Lichess bez ponownego logowania
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

    // „wdrożenie”: serwer ma nową wersję, przeglądarka ma starą w pamięci (max-age=600)
    name = 'Wersja Dwa';
    page = await open(ctx);
    await expect(page.locator('h1')).toHaveText('Wersja Dwa');
    await page.close();

    // bez sieci aplikacja otwiera się z pamięci service workera
    await ctx.setOffline(true);
    page = await open(ctx);
    await expect(page.locator('h1')).toHaveText('Wersja Dwa');
    await ctx.close();
  } finally {
    pages.close();
  }
});

test('konto: rejestracja, pokój na koncie, logowanie na nowym telefonie przywraca pokój i poczekalnię', async ({ browser }) => {
  const nick = 'Kon' + Math.random().toString(36).slice(2, 6);
  const A = await phone(browser);
  await A.page.goto(FRONT + '/');
  await expect(A.page.getByRole('heading', { name: 'Bez konta Lichess' })).toBeVisible();
  await expect(A.page.getByRole('heading', { name: 'Przez Lichess' })).toBeVisible();

  // rejestracja przy pierwszej szybkiej grze
  await A.page.getByRole('button', { name: /Szybka gra/ }).click();
  await expect(A.page.getByRole('heading', { name: 'Załóż konto' })).toBeVisible();
  await A.page.locator('#room-nick').fill(nick);
  await A.page.locator('#acct-pass').fill('krotkie');
  await A.page.getByRole('button', { name: 'Załóż konto' }).click();
  await expect(A.page.locator('#toast')).toContainText('co najmniej 8');
  await A.page.locator('#acct-pass').fill('moje-haslo-123');
  await A.page.locator('#acct-email').fill(nick + '@example.com');
  await A.page.getByRole('button', { name: 'Załóż konto' }).click();
  await expect(A.page.locator('.who')).toContainText(nick);
  await expect(A.page.getByText('Konto bez hasła')).toHaveCount(0);

  // menu → pokój ze znajomymi: nick z konta, pokój zapisany na koncie
  await A.page.getByRole('button', { name: 'Menu' }).click();
  await expect(A.page.locator('.account-line')).toContainText('Grasz jako ' + nick);
  await A.page.getByRole('button', { name: /Pokój ze znajomymi/ }).click();
  await expect(A.page.locator('#room-nick')).toHaveValue(nick);
  await A.page.locator('#room-name').fill('Pokój konta');
  await A.page.getByRole('button', { name: 'Utwórz pokój' }).click();
  await expect(A.page.getByRole('heading', { name: 'Pokój „Pokój konta”' })).toBeVisible();
  await A.ctx.close();

  // nowy telefon: logowanie
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
  await expect(C.page.getByRole('button', { name: /Pokój ze znajomymi/ })).toContainText('„Pokój konta”');
  await C.page.getByRole('button', { name: /Pokój ze znajomymi/ }).click();
  await expect(C.page.locator('.who')).toContainText(nick);
  await expect(C.page.locator('.who')).toContainText('Pokój konta');
  await C.page.getByRole('button', { name: 'Menu' }).click();
  await C.page.getByRole('button', { name: /Szybka gra/ }).click();
  await expect(C.page.locator('.who')).toContainText('Poczekalnia ogólna');

  // konto: wylogowanie z urządzenia i „nie pamiętam hasła”
  await C.page.locator('button[aria-label="Konto"]').click();
  await expect(C.page.getByRole('heading', { name: 'Twoje konto' })).toBeVisible();
  await expect(C.page.locator('.dialog')).toContainText(nick + '@example.com');
  await C.page.getByRole('button', { name: 'Wyloguj z tego urządzenia' }).click();
  await C.page.locator('.dialog').getByRole('button', { name: 'Wyloguj' }).click();
  await expect(C.page.getByRole('button', { name: 'Mam konto — zaloguj się' })).toBeVisible();
  await C.page.getByRole('button', { name: 'Mam konto — zaloguj się' }).click();
  await C.page.getByRole('button', { name: 'Nie pamiętam hasła' }).click();
  await C.page.locator('#acct-login').fill(nick);
  await C.page.getByRole('button', { name: 'Wyślij link' }).click();
  await expect(C.page.locator('.note')).toContainText('nie jest jeszcze włączone');
  await C.ctx.close();
});

test('wpisywanie notacją: podpowiedzi, ruch niejednoznaczny (Nbd2), polskie litery, tryb „skąd → dokąd”', async ({ browser }) => {
  // dwa telefony w pokoju — ruchy obu stron są przewidywalne (w demo komputer gra losowo)
  const A = await phone(browser);
  const B = await phone(browser);
  await A.page.goto(FRONT + '/');
  await A.page.getByRole('button', { name: /Pokój ze znajomymi/ }).click();
  await A.page.locator('#room-name').fill('Notacja');
  await A.page.locator('#room-nick').fill('Biały');
  await A.page.getByRole('button', { name: 'Utwórz pokój' }).click();
  const invite = await A.page.locator('#invite-link').inputValue();
  await A.page.getByRole('button', { name: 'Gotowe' }).click();
  await B.page.goto(invite);
  await B.page.locator('#room-nick').fill('Czarny');
  await B.page.getByRole('button', { name: 'Dołącz' }).click();
  await A.page.locator('button.tab[data-action="mode"][data-id="member"]').click();
  await A.page.locator('button.chip[data-action="color"][data-id="white"]').click();
  await A.page.getByRole('button', { name: 'Wyślij wyzwanie' }).click();
  await B.page.getByRole('button', { name: 'Przyjmij' }).click();
  const W = A.page;
  const Bl = B.page;
  await expect(W.locator('.status')).toHaveText('Twój ruch');

  // podpowiedzi w trakcie wpisywania i opis gotowego ruchu
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

  // ruch niemożliwy
  await typeSan(W, 'e6');
  await expect(W.locator('.entry-msg')).toContainText('Nie ma takiego ruchu');
  await expect(W.getByRole('button', { name: 'Wyślij ruch' })).toBeDisabled();
  await W.getByRole('button', { name: '⌫ Cofnij' }).click();
  await W.getByRole('button', { name: '⌫ Cofnij' }).click();

  await play(W, 'd4');
  await expect(Bl.locator('.lm-san')).toHaveText('d4');
  await play(Bl, 'e6');
  await expect(W.locator('.lm-san')).toHaveText('e6');

  // Nd2: mogą skoczek b1 i skoczek f3 → podpowiedź, jak dopisać kolumnę (bez pytania „którą”)
  await typeSan(W, 'Nd2');
  await expect(W.locator('.entry-msg')).toContainText('Nbd2');
  await expect(W.locator('.entry-msg')).toContainText('Nfd2');
  await expect(W.getByRole('button', { name: 'Wyślij ruch' })).toBeDisabled();
  for (let i = 0; i < 3; i++) await W.getByRole('button', { name: '⌫ Cofnij' }).click();
  await play(W, 'Nbd2');
  await expect(Bl.locator('.lm-san')).toHaveText('Nbd2');

  // polskie litery figur (ustawienie): wyświetlanie i przyciski
  await Bl.locator('.g-top button[data-action="game-menu"]').click();
  await Bl.getByRole('button', { name: 'Ustawienia' }).click();
  await Bl.locator('input[data-key="englishNotation"]').uncheck();
  await Bl.getByRole('button', { name: 'Gotowe' }).click();
  await expect(Bl.locator('.lm-san')).toHaveText('Sbd2');
  await expect(Bl.locator('#entry button.key.piece[data-k="N"]')).toContainText('S');

  // tryb „skąd → dokąd”
  await Bl.getByRole('button', { name: /przełącz na „skąd → dokąd”/ }).click();
  await expect(Bl.locator('.slots .slot')).toHaveCount(4);
  for (const ch of 'c7c5') await Bl.locator(`#entry button.key[data-k="${ch}"]`).click();
  await Bl.getByRole('button', { name: 'Wyślij ruch' }).click();
  await expect(W.locator('.lm-san')).toHaveText('c5');
  await A.ctx.close(); await B.ctx.close();
});

test('cofnięcie ruchu za zgodą rywala; strona statystyk z kluczem', async ({ browser }) => {
  const A = await phone(browser);
  const B = await phone(browser);
  await A.page.goto(FRONT + '/');
  await A.page.getByRole('button', { name: /Pokój ze znajomymi/ }).click();
  await A.page.locator('#room-name').fill('Klub cofania');
  await A.page.locator('#room-nick').fill('Ala');
  await A.page.getByRole('button', { name: 'Utwórz pokój' }).click();
  const invite = await A.page.locator('#invite-link').inputValue();
  await A.page.getByRole('button', { name: 'Gotowe' }).click();
  await B.page.goto(invite);
  await B.page.locator('#room-nick').fill('Olek');
  await B.page.getByRole('button', { name: 'Dołącz' }).click();
  await A.page.locator('button.tab[data-action="mode"][data-id="member"]').click();
  await A.page.locator('button.chip[data-action="color"][data-id="white"]').click();
  await A.page.getByRole('button', { name: 'Wyślij wyzwanie' }).click();
  await B.page.getByRole('button', { name: 'Przyjmij' }).click();
  const W = A.page; const Bl = B.page;

  await play(W, 'e4');
  await expect(Bl.locator('.lm-san')).toHaveText('e4');
  await play(Bl, 'e5');
  await expect(W.locator('.lm-san')).toHaveText('e5');
  await play(W, 'Nc3'); // pomyłka: chciał Nf3
  await expect(Bl.locator('.lm-san')).toHaveText('Nc3');

  // prośba → rywal widzi i może odmówić
  await W.getByRole('button', { name: 'Cofnij mój ruch' }).click();
  await W.locator('.dialog').getByRole('button', { name: 'Poproś' }).click();
  await expect(W.getByText('czekam na zgodę rywala')).toBeVisible();
  await expect(Bl.getByText('Rywal prosi o cofnięcie')).toBeVisible();
  await Bl.getByRole('button', { name: 'Odmów' }).click();
  await expect(W.getByText('czekam na zgodę rywala')).toBeHidden();

  // ponowna prośba → zgoda
  await W.getByRole('button', { name: 'Cofnij mój ruch' }).click();
  await W.locator('.dialog').getByRole('button', { name: 'Poproś' }).click();
  await Bl.getByRole('button', { name: 'Zgódź się' }).click();
  await expect(W.locator('.entry-msg')).toContainText('Cofnięto: Nc3');
  await expect(Bl.locator('.entry-msg')).toContainText('Cofnięto: Nc3');
  await expect(W.locator('.status')).toHaveText('Twój ruch');
  await expect(Bl.locator('.lm-san')).toHaveText('e4');
  await play(W, 'Nf3');
  await expect(Bl.locator('.lm-san')).toHaveText('Nf3');

  // koniec partii i statystyki
  await Bl.getByRole('button', { name: 'Poddaj' }).click();
  await Bl.locator('.dialog').getByRole('button', { name: 'Poddaj' }).click();
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

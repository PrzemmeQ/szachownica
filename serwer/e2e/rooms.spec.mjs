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
  frontA = await serveFront(8081, null);
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

async function play(page, from, to) {
  for (const ch of from + to) await page.locator(`#entry button.key[data-k="${ch}"]`).click();
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
  await A.page.getByRole('button', { name: 'Graj w pokoju (bez Lichess)' }).click();
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
  await play(A.page, 'e2', 'e4');
  await expect(B.page.locator('.lm-san')).toHaveText('e4');
  await expect.poll(() => B.page.evaluate(() => window.__spoken.at(-1))).toBe('Pion e 2 na e 4');
  await play(B.page, 'e7', 'e5');
  await expect(A.page.locator('.lm-san')).toHaveText('e5');
  await expect.poll(() => A.page.evaluate(() => window.__spoken.at(-1))).toBe('Pion e 7 na e 5');
  await play(A.page, 'g1', 'f3');
  await expect(B.page.locator('.lm-san')).toHaveText('Sf3');
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
  await play(B.page, 'b8', 'c6');
  await expect(A.page.locator('.lm-san')).toHaveText('Sc6');
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
  // blitz osobno: tam nadal brak rankingu
  await A.page.locator('button.tab[data-action="rank-speed"][data-id="blitz"]').click();
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
  await play(page, 'd2', 'd4');
  await expect(page.locator('.lm-san')).not.toHaveText('—', { timeout: 10000 });
  await ctx.close();
});

test('demo działa też, gdy pokoje są włączone', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await page.goto(FRONT + '/');
  await expect(page.getByRole('button', { name: 'Zaloguj przez Lichess' })).toBeVisible();
  await page.getByRole('button', { name: 'Wypróbuj bez logowania' }).click();
  await page.getByRole('button', { name: 'Zagraj z komputerem' }).click();
  await expect(page.locator('.g-meta')).toBeVisible();
  await ctx.close();
});

// Ikony PNG aplikacji z logo SVG (Playwright/Chromium). Uruchom: node scripts/ikony.mjs
// Wersja „maskable” (Android przycina do kółka) ma logo pomniejszone do bezpiecznej strefy.
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(here, '../../przy-szachownicy');
const logo = await fs.readFile(path.join(FRONT, 'logo.svg'), 'utf8');
const maskable = logo
  .replace('<g id="pawn"', '<g transform="translate(627 627) scale(0.78) translate(-627 -627)"><g id="pawn"')
  .replace(/<\/g>\s*<\/svg>\s*$/, '</g></g></svg>');

const OUT = [
  ['icon-192.png', 192, logo],
  ['icon-512.png', 512, logo],
  ['apple-touch-icon.png', 180, logo],
  ['icon-512-maskable.png', 512, maskable],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, svg] of OUT) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(FRONT, name), omitBackground: false });
  console.log(name, size);
}
await browser.close();

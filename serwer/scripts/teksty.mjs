// Zbiera wszystkie teksty interfejsu do tłumaczenia → przy-szachownicy/lang/pl.json (wzorzec).
// Uruchom: node scripts/teksty.mjs            — tworzy pl.json i pokazuje, czego brakuje w innych językach
//          node scripts/teksty.mjs en         — dodatkowo zapisuje lang/en.missing.json (do przetłumaczenia)
//
// Nowy język: skopiuj pl.json jako <kod>.json, przetłumacz WARTOŚCI (klucze i {zmienne} zostają), dopisz język
// w przy-szachownicy/i18n.js (LANGS) i flagę w przy-szachownicy/flags/. Nagrania głosu: audio/<kod>/<kod>-<klucz>.mp3
// dla kluczy z sekcji „speech” oraz audio/<kod>/index.json z listą nagranych kluczy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(here, '../../przy-szachownicy');
const SERVER = path.resolve(here, '../src');
const FRONT_FILES = ['app.js', 'rooms.js', 'lichess.js', 'demo.js', 'notation.js'];
const PROSE = /[a-ząćęłńóśźż]{2,}|[ĄĆĘŁŃÓŚŹŻąćęłńóśźż]/;
// teksty spoza t(): tylko wyraźnie polskie zdania/etykiety (bez klas CSS, nazw zdarzeń, komunikatów technicznych)
const looksUi = (s) => PROSE.test(s) && !/[{};=<>]|^\w+[:/]|^\(/.test(s) && !/^[\w.-]+$/.test(s.trim())
  && (/[ĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(s) || /^[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]/.test(s.trim()) || /^[\d„—·]/.test(s.trim()))
  && !/^[a-z ]+$/.test(s.trim());

const messages = new Map();
const plurals = new Map();
const add = (s) => { if (s && typeof s === 'string') messages.set(s, s); };

for (const f of FRONT_FILES) {
  const src = fs.readFileSync(path.join(FRONT, f), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  walk.full(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
      if (n.callee.name === 't' && n.arguments[0]?.type === 'Literal') add(n.arguments[0].value);
      if (n.callee.name === 'tn' && n.arguments[1]?.type === 'Literal') plurals.set(n.arguments[1].value, n.arguments[1].value);
    }
    // teksty przekazywane do funkcji pomocniczych i stałych (tłumaczone przy wyświetlaniu)
    if (n.type === 'Literal' && typeof n.value === 'string' && looksUi(n.value) && !n.value.includes('\n')) add(n.value.trim());
  });
}
// komunikaty serwera: fail('…') i fail(`… ${x} …`) → dokładne teksty albo wzorce
const patterns = new Map();
for (const f of fs.readdirSync(SERVER).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(SERVER, f), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  walk.full(ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const name = n.callee.type === 'Identifier' ? n.callee.name : n.callee.property?.name;
    if (name !== 'fail' && name !== 'json') return;
    const a = name === 'fail' ? n.arguments[0] : n.arguments[0]?.properties?.find((p) => p.key?.name === 'error')?.value;
    if (!a) return;
    if (a.type === 'Literal' && typeof a.value === 'string') add(a.value);
    if (a.type === 'TemplateLiteral') {
      let re = '^', out = '', i = 1;
      a.quasis.forEach((q, k) => {
        re += q.value.cooked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out += q.value.cooked;
        if (k < a.expressions.length) { re += '(.+?)'; out += '$' + i++; }
      });
      patterns.set(re + '$', out);
    }
  });
}
// stały wzorzec z klubów (liczba prób)
patterns.set('^Nie ma klubu o takim kodzie albo hasło jest złe\\. Pozostało prób: (\\d+)\\.$', 'Nie ma klubu o takim kodzie albo hasło jest złe. Pozostało prób: $1.');

const { PL_SPEECH } = await import(pathToUrl(path.join(FRONT, 'speech.js'))).catch(() => ({ PL_SPEECH: null }));
function pathToUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

const sorted = (m) => Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pl')));
const pl = {
  _info: 'Wzorzec tłumaczeń (polski). Tłumacz tylko wartości; klucze, {zmienne} i $1 zostają. Generuje: node serwer/scripts/teksty.mjs',
  messages: sorted(messages), plurals: sorted(plurals), patterns: [...patterns.entries()], speech: PL_SPEECH || {},
};
fs.writeFileSync(path.join(FRONT, 'lang/pl.json'), JSON.stringify(pl, null, 2) + '\n');
console.log(`pl.json: ${messages.size} tekstów, ${plurals.size} liczb mnogich, ${patterns.size} wzorców, ${Object.keys(pl.speech).length} wypowiedzi`);

for (const file of fs.readdirSync(path.join(FRONT, 'lang')).filter((x) => /^[a-z]{2}\.json$/.test(x) && x !== 'pl.json')) {
  const code = file.slice(0, 2);
  const other = JSON.parse(fs.readFileSync(path.join(FRONT, 'lang', file), 'utf8'));
  const miss = {
    messages: Object.fromEntries([...messages.keys()].filter((k) => !other.messages?.[k]).map((k) => [k, k])),
    plurals: Object.fromEntries([...plurals.keys()].filter((k) => !other.plurals?.[k]).map((k) => [k, k])),
    speech: Object.fromEntries(Object.keys(pl.speech).filter((k) => !other.speech?.[k]).map((k) => [k, pl.speech[k]])),
  };
  const n = Object.keys(miss.messages).length + Object.keys(miss.plurals).length + Object.keys(miss.speech).length;
  console.log(`${file}: brakuje ${n}`);
  if (process.argv[2] === code) fs.writeFileSync(path.join(FRONT, `lang/${code}.missing.json`), JSON.stringify(miss, null, 2) + '\n');
}

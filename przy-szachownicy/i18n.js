// Tłumaczenia. Tekst źródłowy (polski) jest w kodzie: t('Załóż konto'). Inne języki to pliki lang/<kod>.json:
//   messages  — „polski tekst” → tłumaczenie (z {zmiennymi}),
//   patterns  — [wyrażenie, tłumaczenie] dla komunikatów serwera z liczbami (np. „Pozostało prób: 3”),
//   plurals   — „partia|partie|partii” → „game|games” (formy wg Intl.PluralRules języka),
//   speech    — teksty czytane na głos (klucze jak w speech.js; nagrania: audio/<kod>/<kod>-<klucz>.mp3).
// Listę tekstów do tłumaczenia tworzy: node serwer/scripts/teksty.mjs (→ lang/pl.json).

export const LANGS = [ // alfabetycznie, nazwa w tym języku
  { code: 'en', name: 'English', flag: 'flags/gb.svg' },
  { code: 'pl', name: 'Polski', flag: 'flags/pl.svg' },
];
const LS = 'ps_lang';
let lang = 'pl';
let pack = null; // null = polski (tekst źródłowy)
let patterns = [];

export function currentLang() { return lang; }
export function langInfo(code = lang) { return LANGS.find((l) => l.code === code) || LANGS.find((l) => l.code === 'pl'); }
export function speechPack() { return pack?.speech || null; }

// Język: zapisany wybór, domyślnie polski.
export async function initLang() {
  let code = 'pl';
  try { code = localStorage.getItem(LS) || 'pl'; } catch {}
  await loadLang(code);
}
export async function loadLang(code) {
  if (!LANGS.some((l) => l.code === code) || code === 'pl') { lang = 'pl'; pack = null; patterns = []; applyDocLang(); return; }
  try {
    const res = await fetch(`lang/${code}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    pack = await res.json();
    lang = code;
    patterns = (pack.patterns || []).map(([re, out]) => [new RegExp(re), out]);
  } catch (e) { console.warn('lang', code, e); lang = 'pl'; pack = null; patterns = []; }
  applyDocLang();
}
export async function setLang(code) {
  try { localStorage.setItem(LS, code); } catch {}
  await loadLang(code);
}
function applyDocLang() { try { document.documentElement.lang = lang; } catch {} }

function fill(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}
// Tekst w bieżącym języku. Brak tłumaczenia → polski oryginał (nic się nie psuje).
export function t(s, params) {
  if (s == null) return '';
  let out = s;
  if (pack) {
    const hit = pack.messages?.[s];
    if (hit) out = hit;
    else {
      for (const [re, rep] of patterns) { if (re.test(s)) { out = s.replace(re, rep); break; } }
    }
  }
  return fill(out, params);
}
// Liczba mnoga: tn(5, 'partia|partie|partii') → „partii” (pl), „games” (en).
const PL_RULES = new Intl.PluralRules('pl');
export function tn(n, forms, params) {
  const p = { n, ...(params || {}) };
  if (pack) {
    const tr = pack.plurals?.[forms];
    if (tr) {
      const f = tr.split('|');
      const cat = new Intl.PluralRules(lang).select(n);
      const order = f.length === 2 ? { one: 0, other: 1 } : { one: 0, few: 1, many: 2, other: 2 };
      return fill(f[order[cat] ?? f.length - 1], p);
    }
  }
  const f = forms.split('|');
  const cat = PL_RULES.select(n);
  return fill(cat === 'one' ? f[0] : cat === 'few' ? f[1] : f[2] ?? f[1], p);
}
// Data w formacie języka.
export function fmtDate(ts) { return new Date(ts).toLocaleDateString(lang === 'pl' ? 'pl-PL' : lang); }
export function fmtDateTime(ts) { return new Date(ts).toLocaleString(lang === 'pl' ? 'pl-PL' : lang); }

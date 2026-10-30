// Czytanie na głos: każdą wypowiedź składamy z kluczy (np. ['piece-n', 'file-g', 'rank-1', 'to', 'file-f', 'rank-3']).
// Jeśli dla języka są nagrania (audio/<kod>/index.json z listą kluczy), odtwarzamy pliki
// audio/<kod>/<kod>-<klucz>.mp3 po kolei; w przeciwnym razie mówi syntezator mowy (teksty poniżej / lang/<kod>.json → speech).
import { currentLang, speechPack } from './i18n.js';

// Teksty polskie — wzorzec do nagrań i tłumaczeń (klucz = nazwa pliku nagrania).
export const PL_SPEECH = {
  'piece-k': 'Król', 'piece-q': 'Hetman', 'piece-r': 'Wieża', 'piece-b': 'Goniec', 'piece-n': 'Skoczek', 'piece-p': 'Pion',
  'file-a': 'a', 'file-b': 'be', 'file-c': 'ce', 'file-d': 'de', 'file-e': 'e', 'file-f': 'ef', 'file-g': 'gie', 'file-h': 'ha',
  'rank-1': '1', 'rank-2': '2', 'rank-3': '3', 'rank-4': '4', 'rank-5': '5', 'rank-6': '6', 'rank-7': '7', 'rank-8': '8',
  to: 'na', takes: 'bije',
  'castle-short': 'Roszada krótka', 'castle-long': 'Roszada długa',
  'promo-q': 'promocja na hetmana', 'promo-r': 'promocja na wieżę', 'promo-b': 'promocja na gońca', 'promo-n': 'promocja na skoczka',
  check: 'Szach.', mate: 'Mat.',
  win: 'Wygrana.', loss: 'Przegrana.', draw: 'Remis.', aborted: 'Partia przerwana.',
  'opponent-gone': 'Rywal opuścił partię.',
  'takeback-done': 'Cofnięto ruch. Ustaw bierki z powrotem.',
  'takeback-declined': 'Rywal odmówił cofnięcia ruchu. Gra toczy się dalej.',
  'draw-declined': 'Rywal odrzucił remis.',
  'chat': 'Rywal pisze:',
};

// Ruch (chess.js, verbose) → klucze wypowiedzi.
export function moveKeys(m) {
  if (!m) return [];
  const flags = m.flags || '';
  const keys = [];
  if (flags.includes('k')) keys.push('castle-short');
  else if (flags.includes('q')) keys.push('castle-long');
  else {
    const capture = flags.includes('c') || flags.includes('e');
    keys.push('piece-' + m.piece, 'file-' + m.from[0], 'rank-' + m.from[1], capture ? 'takes' : 'to', 'file-' + m.to[0], 'rank-' + m.to[1]);
    if (m.promotion) keys.push('promo-' + m.promotion);
  }
  if (m.san.endsWith('#')) keys.push('mate');
  else if (m.san.endsWith('+')) keys.push('check');
  return keys;
}

export function speechText(key) { return speechPack()?.[key] ?? PL_SPEECH[key] ?? key; }
// Tekst do syntezatora: klucze połączone spacjami (promocja po przecinku, szach/mat jako osobne zdanie).
export function keysText(keys) {
  let s = '';
  for (const k of keys) {
    const w = speechText(k);
    if (k.startsWith('promo-')) s += ', ' + w;
    else if (k === 'check' || k === 'mate') s += '. ' + w;
    else s += (s ? ' ' : '') + w;
  }
  return s;
}

// Nagrania: lista dostępnych kluczy dla języka (audio/<kod>/index.json), wczytywana raz.
const audioIndex = new Map();
async function recordings(lang) {
  if (!audioIndex.has(lang)) {
    audioIndex.set(lang, fetch(`audio/${lang}/index.json`).then((r) => (r.ok ? r.json() : [])).then((a) => new Set(a)).catch(() => new Set()));
  }
  return audioIndex.get(lang);
}
// Odtwarza wypowiedź z nagrań, jeśli są wszystkie potrzebne pliki. Zwraca false, gdy trzeba użyć syntezatora.
export async function playRecorded(keys) {
  const lang = currentLang();
  const have = await recordings(lang);
  if (!keys.length || !keys.every((k) => have.has(k))) return false;
  for (const k of keys) {
    await new Promise((resolve) => {
      const a = new Audio(`audio/${lang}/${lang}-${k}.mp3`);
      a.onended = resolve; a.onerror = resolve;
      a.play().catch(resolve);
    });
  }
  return true;
}

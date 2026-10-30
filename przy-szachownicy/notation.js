// Polska notacja i opisy ruchów (do wyświetlania i czytania na głos).

const PL_LETTER = { K: 'K', Q: 'H', R: 'W', B: 'G', N: 'S' };
const PL_NAME = { k: 'król', q: 'hetman', r: 'wieża', b: 'goniec', n: 'skoczek', p: 'pion' };
const PL_ACC = { q: 'hetmana', r: 'wieżę', b: 'gońca', n: 'skoczka' };

export const PROMO_PIECES = [
  { key: 'q', label: 'H', name: 'Hetman' },
  { key: 'r', label: 'W', name: 'Wieża' },
  { key: 'b', label: 'G', name: 'Goniec' },
  { key: 'n', label: 'S', name: 'Skoczek' },
];

export function sanToPl(san) {
  if (!san) return '';
  return san
    .replace(/^([KQRBN])/, (m) => PL_LETTER[m])
    .replace(/=([QRBN])/, (_m, p) => '=' + PL_LETTER[p]);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// m = ruch chess.js w wersji verbose
export function describeMove(m) {
  if (!m) return '';
  const flags = m.flags || '';
  let text;
  if (flags.includes('k')) text = 'roszada krótka';
  else if (flags.includes('q')) text = 'roszada długa';
  else {
    const capture = flags.includes('c') || flags.includes('e');
    text = `${PL_NAME[m.piece]} ${m.from} ${capture ? '×' : '→'} ${m.to}`;
    if (m.promotion) text += `, promocja: ${PL_NAME[m.promotion]}`;
  }
  if (m.san.endsWith('#')) text += ' — mat';
  else if (m.san.endsWith('+')) text += ' — szach';
  return text;
}

export function speechForMove(m) {
  if (!m) return '';
  const flags = m.flags || '';
  let text;
  if (flags.includes('k')) text = 'Roszada krótka';
  else if (flags.includes('q')) text = 'Roszada długa';
  else {
    const capture = flags.includes('c') || flags.includes('e');
    text = `${cap(PL_NAME[m.piece])} ${spellSquare(m.from)} ${capture ? 'bije' : 'na'} ${spellSquare(m.to)}`;
    if (m.promotion) text += `, promocja na ${PL_ACC[m.promotion]}`;
  }
  if (m.san.endsWith('#')) text += '. Mat.';
  else if (m.san.endsWith('+')) text += '. Szach.';
  return text;
}

// "g8" -> "gie 8" – syntezatory lepiej czytają litery osobno
const LETTER_SPOKEN = { a: 'a', b: 'be', c: 'ce', d: 'de', e: 'e', f: 'ef', g: 'gie', h: 'ha' };
function spellSquare(sq) { return `${LETTER_SPOKEN[sq[0]]} ${sq[1]}`; }

const STATUS_PL = {
  mate: 'Mat',
  resign: 'Poddanie',
  stalemate: 'Pat',
  timeout: 'Rywal opuścił partię',
  draw: 'Remis',
  outoftime: 'Koniec czasu',
  aborted: 'Partia przerwana',
  noStart: 'Partia się nie rozpoczęła',
  cheat: 'Naruszenie zasad',
  insufficientMaterialClaim: 'Remis — za mało materiału',
  variantEnd: 'Koniec partii',
  unknownFinish: 'Koniec partii',
};
export function statusPl(s) { return STATUS_PL[s] || s; }

export const SPEED_PL = {
  ultraBullet: 'UltraBullet', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid',
  classical: 'Klasyczna', correspondence: 'Korespondencyjna', unlimited: 'Bez limitu',
};

export function formatMs(ms) {
  if (ms == null || isNaN(ms)) return '—';
  ms = Math.max(0, ms);
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  if (days >= 1) {
    const h = Math.floor((totalSec % 86400) / 3600);
    return `${days} d ${h} h`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (ms < 10000) return `${m}:${String(s).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

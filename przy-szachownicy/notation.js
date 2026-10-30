// Notacja i opisy ruchów (do wyświetlania). Czytanie na głos: speech.js. Teksty przez t() (i18n.js).
import { t } from './i18n.js';

const PL_LETTER = { K: 'K', Q: 'H', R: 'W', B: 'G', N: 'S' };
const PIECE_NAME = { k: 'król', q: 'hetman', r: 'wieża', b: 'goniec', n: 'skoczek', p: 'pion' };

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

// m = ruch chess.js w wersji verbose
export function describeMove(m) {
  if (!m) return '';
  const flags = m.flags || '';
  let text;
  if (flags.includes('k')) text = t('roszada krótka');
  else if (flags.includes('q')) text = t('roszada długa');
  else {
    const capture = flags.includes('c') || flags.includes('e');
    text = `${t(PIECE_NAME[m.piece])} ${m.from} ${capture ? '×' : '→'} ${m.to}`;
    if (m.promotion) text += ', ' + t('promocja: {piece}', { piece: t(PIECE_NAME[m.promotion]) });
  }
  if (m.san.endsWith('#')) text += ' — ' + t('mat');
  else if (m.san.endsWith('+')) text += ' — ' + t('szach');
  return text;
}

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
export function statusPl(s) { return STATUS_PL[s] ? t(STATUS_PL[s]) : s; }

const SPEED_PL = {
  ultraBullet: 'UltraBullet', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid',
  classical: 'Klasyczna', correspondence: 'Korespondencyjna', unlimited: 'Bez limitu',
};
export function speedPl(s) { return SPEED_PL[s] ? t(SPEED_PL[s]) : (s || ''); }

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

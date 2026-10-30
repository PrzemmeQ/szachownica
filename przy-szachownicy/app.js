import { CONFIG } from './config.js';
import { Chess } from './chess.js';
import { LichessProvider } from './lichess.js';
import { DemoProvider } from './demo.js';
import {
  RoomsProvider, roomsEnabled, savedAccount, savedClubs, savedClub, myClubs, createRoom, lookupClub, joinClub,
  claimTransfer, claimTransferCode, registerAccount, loginAccount, requestPasswordReset, resetPassword, restoreRoom,
} from './rooms.js';
import {
  sanToPl, describeMove, speechForMove, statusPl, SPEED_PL, formatMs, PROMO_PIECES,
} from './notation.js';

// ---------------------------------------------------------------------------
// Ustawienia użytkownika
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'ps_settings';
const DEFAULT_SETTINGS = { speech: true, vibrate: true, sound: true, autoSend: false, emergencyBoard: true, sanEntry: true, englishNotation: true, learnMode: false };
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.simpleEntry === false && s.sanEntry === undefined) s.sanEntry = false; // dawny tryb „skąd → dokąd”
    delete s.simpleEntry;
    return { ...DEFAULT_SETTINGS, ...s };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch {} }
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ---------------------------------------------------------------------------
// Tempa gry
// ---------------------------------------------------------------------------
const PRESETS = [
  // Najkrócej 10 minut: przy prawdziwej szachownicy trzeba zagrać ruch i jeszcze go wpisać.
  { id: 'r10_0', group: 'Rapid', label: '10+0', time: 10, increment: 0 },
  { id: 'r10_5', group: 'Rapid', label: '10+5', time: 10, increment: 5 },
  { id: 'r15_10', group: 'Rapid', label: '15+10', time: 15, increment: 10 },
  { id: 'r20_0', group: 'Rapid', label: '20+0', time: 20, increment: 0 },
  // klasyczne wg wzoru Lichess (czas + 40 × dodatek ≥ 25 min) — dlatego 25+10 jest tu
  { id: 'c25_10', group: 'Klasyczne', label: '25+10', time: 25, increment: 10 },
  { id: 'c30_0', group: 'Klasyczne', label: '30+0', time: 30, increment: 0 },
  { id: 'c30_20', group: 'Klasyczne', label: '30+20', time: 30, increment: 20 },
  { id: 'c45_15', group: 'Klasyczne', label: '45+15', time: 45, increment: 15 },
  { id: 'c60_30', group: 'Klasyczne', label: '60+30', time: 60, increment: 30 },
  { id: 'c90_30', group: 'Klasyczne', label: '90+30', time: 90, increment: 30 },
  { id: 'd1', group: 'Korespondencja', label: '1 dzień', days: 1 },
  { id: 'd3', group: 'Korespondencja', label: '3 dni', days: 3 },
  { id: 'd7', group: 'Korespondencja', label: '7 dni', days: 7 },
];
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];

// ---------------------------------------------------------------------------
// Stan aplikacji
// ---------------------------------------------------------------------------
const S = {
  provider: null,
  user: null,
  view: 'loading', // loading | start | room-new | club-join | account | lobby | game
  online: true,
  ongoing: [],
  challenges: new Map(),
  waiting: null, // { text, cancel?, kind }
  game: null,
  input: [],
  san: '', // wpis notacją, np. „Nbd7”
  promo: null,
  sending: false,
  entryMsg: '',
  modal: null,
  historyOpen: false,
  startError: '',
  settings: loadSettings(),
  form: {
    mode: 'seek', preset: 'r10_5', rated: true, friend: '', color: 'random', level: 3,
    ...(() => { try { return JSON.parse(lsGet('ps_form') || '{}'); } catch { return {}; } })(),
  },
  bannerHidden: lsGet('ps_banner_hidden') === '1',
  voted: lsGet('ps_vote') ? 'done' : null,
  voteEmail: '',
  streamOpenedAt: 0,
  // wariant B: pokoje
  roomForm: { name: '', nick: lsGet('ps_room_nick') || '' },
  // konto: mode = register | login | forgot | reset; next = dokąd po zalogowaniu (public | room-new | start)
  accountForm: { mode: 'register', nick: lsGet('ps_room_nick') || '', email: '', info: '', token: '', next: 'start' },
  joinRoom: null, // { code, name, error }
  rankSpeed: 'rapid',
  roomHistory: null,
  historyLoading: false,
  roomHistoryOpen: false,
  transfer: null, // { url, expiresIn }
};

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(text, ms = 3500) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function playerLabel(p) {
  if (!p) return '?';
  const t = p.title ? `${p.title} ` : '';
  const r = p.rating ? ` (${p.rating}${p.provisional ? '?' : ''})` : '';
  return `${t}${p.name}${r}`;
}
// Nick: litery łacińskie (z polskimi), cyfry — jak na serwerze (bez liter z innych alfabetów).
const NICK_RE = /^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż _.-]{1,19}$/;
const NICK_ERR = 'Nick: 2–20 znaków — litery (także polskie), cyfry, spacja, _ . -';
function presetById(id) { return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === 'r10_5'); }

// --- dźwięk, mowa, wibracja, blokada ekranu --------------------------------
let audioCtx = null;
let speechUnlocked = false;
function unlockMedia() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  if (!speechUnlocked && 'speechSynthesis' in window) {
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
      speechUnlocked = true;
    } catch {}
  }
}
function beep() {
  if (!S.settings.sound || !audioCtx) return;
  try {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.3);
  } catch {}
}
let plVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  plVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('pl')) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(text) {
  if (!S.settings.speech || !('speechSynthesis' in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pl-PL';
    if (plVoice) u.voice = plVoice;
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch {}
}
function vibrate(p = 120) { if (S.settings.vibrate && navigator.vibrate) { try { navigator.vibrate(p); } catch {} } }

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; }
  if (wakeLock) wakeLock.addEventListener?.('release', () => { wakeLock = null; });
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.view === 'game' && S.game && !gameOver(S.game)) requestWakeLock();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function boot() {
  render();
  if (roomsEnabled() && await bootRoom()) return;
  const lichess = new LichessProvider();
  if (!CONFIG.DEMO_ONLY) {
    let fromLogin = false;
    try {
      fromLogin = await lichess.handleRedirect();
    } catch (e) {
      S.startError = e.message;
    }
    // Do Lichess wchodzimy od razu po zalogowaniu albo gdy ostatnio grano przez Lichess;
    // po „Menu główne” zostajemy na ekranie startowym (token zostaje).
    const last = lsGet('ps_last');
    if (lichess.hasToken() && (fromLogin || !last || last === 'lichess')) {
      await enterWith(lichess);
      return;
    }
  }
  S.view = 'start';
  render();
}

// Wariant B: wejście z linku (?klub=KOD, #przenies=pokój.kod, #reset=…, #nowy-pokoj) albo do ostatnio otwartego miejsca.
// Zwraca true, jeśli zajął się startem.
async function bootRoom() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('klub') || params.get('pokoj') || '').trim();
  // tokeny (przeniesienie, zmiana hasła) są po # — nie trafiają do logów serwera stron
  const hash = new URLSearchParams(location.hash.slice(1));
  const transfer = (hash.get('przenies') || '').trim();
  const reset = (hash.get('reset') || '').trim();
  const clean = () => history.replaceState(null, '', location.pathname);
  if (location.hash === '#nowy-pokoj') { // ze strony dla klubów: od razu zakładanie klubu
    clean();
    S.view = 'room-new';
    render();
    return true;
  }
  if (reset) {
    clean();
    S.accountForm = { ...S.accountForm, mode: 'reset', token: reset, next: 'public' };
    S.view = 'account';
    render();
    return true;
  }
  if (transfer) {
    clean();
    S.view = 'loading'; render();
    try {
      const [room, tcode] = transfer.split('.');
      await enterWith(new RoomsProvider(await claimTransfer(room, tcode)));
    } catch (e) {
      S.startError = e.message; S.view = 'start'; render();
    }
    return true;
  }
  if (code) {
    clean();
    await openClubJoin(code);
    return true;
  }
  if (params.has('code') || params.has('error')) return false; // powrót z logowania Lichess
  const last = lsGet('ps_last') || '';
  if (last === 'public' && savedAccount()) { await enterWith(new RoomsProvider(savedAccount())); return true; }
  if (last.startsWith('club:')) {
    const c = savedClub(last.slice(5));
    if (c) { await enterWith(new RoomsProvider(c)); return true; }
  }
  // iPhone: aplikacja z ekranu głównego ma osobną pamięć od Safari — przy pierwszym uruchomieniu wyjaśnij
  if (isStandalone() && !savedAccount() && !savedClubs().length && !lsGet('ps_standalone_seen')) {
    lsSet('ps_standalone_seen', '1');
    S.standaloneHint = true;
  }
  return false;
}
function isStandalone() {
  try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; }
}

async function enterWith(provider) {
  S.provider = provider;
  S.view = 'loading';
  render();
  lsSet('ps_last', provider.lastKey || provider.name);
  try {
    S.user = await provider.account();
    provider.userId = S.user.id;
  } catch (e) {
    S.provider = null;
    S.startError = e.message || (provider.features?.rooms ? 'Nie udało się połączyć z serwerem.' : 'Nie udało się połączyć z Lichess.');
    S.view = 'start';
    render();
    return;
  }
  S.view = 'lobby';
  S.streamOpenedAt = Date.now();
  provider.startEvents(onProviderEvent);
  await refreshOngoing();
  render();
}

async function refreshOngoing() {
  if (!S.provider) return;
  try { S.ongoing = await S.provider.ongoing(); } catch (e) { console.warn(e); }
  if (S.view === 'lobby') render();
}

async function logout() {
  closeGame();
  const p = S.provider;
  S.provider = null; S.user = null; S.ongoing = []; S.challenges.clear();
  S.roomHistory = null; S.transfer = null;
  S.view = 'start';
  render();
  if (p) await p.logout();
  if (S.view === 'start') render(); // konto/klub zniknęły z urządzenia — odśwież ekran startowy
}

// Menu główne: wyjście do ekranu startowego bez wylogowania. Konto i kluby zostają na urządzeniu.
function goMenu() {
  const w = S.waiting;
  S.waiting = null;
  try { w?.cancel?.(); } catch {}
  closeGame();
  const p = S.provider;
  S.provider = null; S.user = null; S.ongoing = []; S.challenges.clear();
  S.roomHistory = null; S.transfer = null; S.modal = null; S.coach = null;
  lsSet('ps_last', 'menu');
  S.startError = '';
  S.view = 'start';
  if (p) {
    p.stopEvents();
    p.disconnect?.();
    if (p.isDemo) p.logout();
  }
  render();
}

// Wejście do klubu z listy „Moje kluby”: z tego urządzenia albo (po zalogowaniu) przypięty do konta.
async function openClub(room) {
  S.startError = '';
  let c = savedClub(room);
  if (!c) {
    S.waiting = { text: 'Otwieram klub…', kind: 'pending' }; render();
    try { c = await restoreRoom(room); } catch (e) { S.waiting = null; toast(e.message, 5000); render(); return; }
    S.waiting = null;
  }
  await enterWith(new RoomsProvider(c));
}

// Zakładanie klubu.
async function submitRoom() {
  unlockMedia();
  const f = S.roomForm;
  const nick = f.nick.trim() || savedAccount()?.nick || '';
  if (!NICK_RE.test(nick)) { toast(NICK_ERR); return; }
  if (!f.name.trim()) { toast('Wpisz nazwę klubu.'); return; }
  lsSet('ps_room_nick', nick);
  S.waiting = { text: 'Zakładam klub…', kind: 'pending' }; render();
  try {
    const saved = await createRoom(f.name.trim(), nick);
    S.waiting = null; S.startError = '';
    await enterWith(new RoomsProvider(saved));
    if (S.provider) S.modal = { kind: 'room' };
    render();
  } catch (e) {
    S.waiting = null; toast(e.message, 5000); render();
  }
}

// Dołączanie kodem: najpierw sprawdzenie kodu (nazwa klubu, czy jest hasło), potem nick/hasło.
async function openClubJoin(code) {
  S.joinRoom = { code: code || '', name: null, needsPassword: false, error: '', checked: false };
  S.view = 'club-join';
  render();
  if (code) await checkClubCode();
}
async function checkClubCode() {
  const j = S.joinRoom;
  const code = (document.getElementById('club-code')?.value ?? j.code).trim();
  if (!code) { toast('Wpisz kod klubu.'); return; }
  j.code = code; j.error = '';
  try {
    const d = await lookupClub(code);
    Object.assign(j, { code: d.code, name: d.name, needsPassword: d.needsPassword, checked: true });
    const mine = savedClubs().find((c) => c.code === d.code);
    if (mine) { await enterWith(new RoomsProvider(mine)); return; } // już jestem w tym klubie
  } catch (e) { j.error = e.message; j.checked = false; }
  render();
}
async function submitJoin() {
  unlockMedia();
  const j = S.joinRoom;
  if (!j?.checked) { await checkClubCode(); return; }
  const nick = (document.getElementById('room-nick')?.value ?? S.roomForm.nick).trim() || savedAccount()?.nick || '';
  const password = document.getElementById('club-pass')?.value || '';
  if (!NICK_RE.test(nick)) { toast(NICK_ERR); return; }
  if (j.needsPassword && !password) { toast('Wpisz hasło klubu.'); return; }
  lsSet('ps_room_nick', nick);
  S.waiting = { text: 'Dołączam…', kind: 'pending' }; render();
  try {
    const saved = await joinClub(j.code, nick, password);
    S.waiting = null; S.joinRoom = null; S.startError = '';
    await enterWith(new RoomsProvider(saved));
  } catch (e) {
    S.waiting = null; j.error = e.message; render();
  }
}
// Kod przeniesienia (6 cyfr) z innego urządzenia.
async function submitTransferCode() {
  const code6 = (document.getElementById('transfer-code')?.value || '').replace(/\D/g, '');
  if (code6.length !== 6) { toast('Kod przeniesienia ma 6 cyfr.'); return; }
  S.waiting = { text: 'Przenoszę…', kind: 'pending' }; render();
  try {
    const saved = await claimTransferCode(code6);
    S.waiting = null;
    await enterWith(new RoomsProvider(saved));
  } catch (e) { S.waiting = null; toast(e.message, 5000); render(); }
}

// --- konto ---------------------------------------------------------------------------
function openAccount(mode, next) {
  S.accountForm = { ...S.accountForm, mode, next: next || 'start', info: '' };
  S.startError = '';
  S.view = 'account';
  render();
}

async function submitAccount(kind) {
  unlockMedia();
  const f = S.accountForm;
  const val = (id) => (document.getElementById(id)?.value || '');
  const password = val('acct-pass');
  try {
    let r;
    if (kind === 'forgot') {
      const login = val('acct-login').trim();
      if (!login) { toast('Wpisz nick albo e-mail.'); return; }
      S.waiting = { text: 'Wysyłam…', kind: 'pending' }; render();
      const d = await requestPasswordReset(login);
      S.waiting = null;
      f.info = d.mailEnabled
        ? 'Jeśli to konto ma podany e-mail, wysłaliśmy na niego link do zmiany hasła (ważny 1 godzinę). Sprawdź też spam.'
        : 'Odzyskiwanie hasła e-mailem nie jest jeszcze włączone. Jeśli grasz jeszcze na innym urządzeniu, zmień hasło tam (menu Konto).';
      render();
      return;
    }
    if (password.length < 8 && kind !== 'login') { toast('Hasło musi mieć co najmniej 8 znaków.'); return; }
    const nick = f.nick.trim();
    if (kind !== 'reset' && !nick) { toast('Wpisz nick.'); return; }
    if (kind === 'register' && !NICK_RE.test(nick)) { toast(NICK_ERR); return; }
    S.waiting = { text: kind === 'register' ? 'Zakładam konto…' : 'Loguję…', kind: 'pending' }; render();
    if (kind === 'register') r = await registerAccount(nick, password, val('acct-email').trim());
    else if (kind === 'login') r = await loginAccount(nick, password);
    else r = await resetPassword(f.token, password);
    lsSet('ps_room_nick', r.saved.nick);
    // kluby przypięte do konta pojawią się w „Moje kluby” (otworzą się jednym kliknięciem)
    S.waiting = null;
    S.roomForm.nick = r.saved.nick;
    if (f.next === 'public') { await enterWith(new RoomsProvider(r.saved)); return; }
    if (f.next === 'room-new') { S.view = 'room-new'; render(); return; }
    S.view = 'start';
    toast(kind === 'register' ? `Konto ${r.saved.nick} założone.` : `Zalogowano jako ${r.saved.nick}.`);
    render();
  } catch (e) {
    S.waiting = null; toast(e.message, 5000); render();
  }
}

async function shareLink(url, title) {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Skopiowano link.'); }
  catch { toast('Skopiuj link ręcznie.'); }
}

async function loadRoomHistory() {
  if (!S.provider?.features?.rooms) return;
  S.historyLoading = true;
  try { S.roomHistory = await S.provider.history(); } catch (e) { toast(e.message); }
  S.historyLoading = false;
  if (S.view === 'lobby') render();
}

// ---------------------------------------------------------------------------
// Zdarzenia z serwera (nowe partie, wyzwania)
// ---------------------------------------------------------------------------
function onProviderEvent(ev) {
  const quiet = Date.now() - S.streamOpenedAt < 3000;
  switch (ev.type) {
    case 'streamStatus':
      S.online = ev.ok;
      if (ev.ok && ev.resetChallenges) {
        S.challenges.clear();
        if (!quiet) refreshOngoing();
      }
      if (S.view === 'lobby') render();
      break;
    case 'authLost':
      toast(S.provider?.features?.rooms
        ? (S.provider.authRemoved ? 'Zostałeś usunięty z tego klubu.'
          : S.provider.isPublic ? 'Sesja konta wygasła — zaloguj się ponownie.' : 'Nie rozpoznano Cię w klubie — dołącz ponownie kodem klubu.')
        : 'Sesja Lichess wygasła — zaloguj się ponownie.', 6000);
      logout();
      break;
    case 'members':
      if (S.provider?.me) S.user = { ...S.user, ratings: roomRatings(S.provider.me.ratings) };
      if (S.view === 'lobby' || S.view === 'coach') render();
      break;
    case 'seeks':
    case 'social':
      if (S.view === 'lobby') render();
      break;
    case 'friendInvite':
      toast(`${ev.from} zaprasza Cię do znajomych.`, 5000); beep(); // zdarzenie na żywo — nie z odtwarzania po połączeniu
      break;
    case 'gameStart': {
      const g = ev.game;
      if (!g.boardCompatible) break;
      S.ongoing = [g, ...S.ongoing.filter((x) => x.id !== g.id)];
      if (S.waiting && S.waiting.kind !== 'correspondence') {
        S.waiting = null;
        openGame(g.id, g.color);
      } else if (S.view === 'game' && S.game?.id === g.id) {
        // już otwarta
      } else if (!quiet) {
        toast(`Nowa partia: ${g.opponent.name}`);
        beep();
        if (S.view === 'lobby') render();
      } else if (S.view === 'lobby') render();
      break;
    }
    case 'gameFinish':
      S.ongoing = S.ongoing.filter((x) => x.id !== ev.game.id);
      if (S.roomHistory) loadRoomHistory();
      if (S.view === 'lobby') render();
      break;
    case 'challenge': {
      S.challenges.set(ev.challenge.id, ev.challenge);
      // rewanż od rywala, którego wynik właśnie oglądam — przycisk „Rewanż” zaczyna migać
      const rm = S.view === 'game' && rematchOffer();
      if (!quiet) { if (!rm) toast(`Wyzwanie od ${ev.challenge.from}`); beep(); vibrate([80, 60, 80]); }
      if (S.view === 'lobby' || rm) render();
      break;
    }
    case 'challengeGone':
      S.challenges.delete(ev.id);
      if (S.view === 'lobby' || S.view === 'game') render();
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Nowa partia
// ---------------------------------------------------------------------------
function waitFor(handle, text) {
  const w = { text, cancel: handle.cancel, kind: 'realtime' };
  S.waiting = w;
  render();
  handle.done.then((result) => {
    if (S.waiting !== w) return;
    if (result === 'declined') { S.waiting = null; toast('Rywal odrzucił wyzwanie.'); render(); return; }
    if (result === 'canceled') { S.waiting = null; toast('Wyzwanie anulowane.'); render(); return; }
    // połączenie zamknięte: albo para znaleziona (gameStart zaraz dotrze), albo wygasło
    setTimeout(() => {
      if (S.waiting === w) { S.waiting = null; toast('Nikt nie dołączył. Spróbuj jeszcze raz.'); render(); }
    }, 5000);
  }).catch((e) => {
    if (S.waiting !== w) return;
    S.waiting = null;
    if (e.name !== 'AbortError') toast(e.message || 'Błąd połączenia.');
    render();
  });
}

async function startNewGame() {
  unlockMedia();
  const f = S.form;
  const p = presetById(f.preset);
  const opts = { time: p.time, increment: p.increment, days: p.days, rated: f.rated && !ratedBlockReason(), color: f.color };
  try {
    if (f.mode === 'seek') {
      S.waiting = { text: 'Łączenie…', kind: 'pending' }; render();
      const h = await S.provider.seek({ ...opts, color: undefined });
      if (h.matched) {
        // ktoś już czekał na to tempo — partia ruszyła (gameStart już otworzył ekran gry)
        if (S.waiting?.kind === 'pending') S.waiting = null;
        render();
        return;
      }
      if (h.correspondence) {
        S.waiting = null;
        toast('Ogłoszenie wystawione. Partia pojawi się na liście, gdy ktoś dołączy.', 6000);
        render();
        return;
      }
      waitFor(h, `Szukam rywala · ${p.group} ${p.label}${f.rated ? ' · rankingowa' : ''}`);
    } else if (f.mode === 'friend') {
      const name = f.friend.trim();
      if (!/^[A-Za-z0-9_-]{2,30}$/.test(name)) { toast('Wpisz poprawny nick z Lichess.'); return; }
      S.waiting = { text: 'Wysyłanie wyzwania…', kind: 'pending' }; render();
      const h = await S.provider.challenge(name, opts);
      if (h.correspondence) {
        S.waiting = null;
        toast(`Wyzwanie wysłane do ${name}. Partia pojawi się na liście po przyjęciu.`, 6000);
        render();
        return;
      }
      waitFor(h, `Czekam, aż ${name} przyjmie wyzwanie`);
    } else if (f.mode === 'member') {
      const opp = findPerson(f.opponent);
      if (!opp) { toast(S.provider.isPublic ? 'Wybierz znajomego, który jest online.' : 'Wybierz rywala z klubu.'); return; }
      S.waiting = { text: 'Wysyłanie wyzwania…', kind: 'pending' }; render();
      const h = await S.provider.challenge(opp.id, opts);
      if (h.matched) { if (S.waiting?.kind === 'pending') S.waiting = null; render(); return; } // rywal wyzwał nas w tym samym czasie
      waitFor(h, `Czekam, aż ${opp.nick} przyjmie wyzwanie${opp.online ? '' : ' (teraz poza klubem)'}`);
    } else {
      S.waiting = { text: 'Uruchamiam partię z komputerem…', kind: 'pending' }; render();
      const { gameId } = await S.provider.challengeAI({ ...opts, level: f.level });
      S.waiting = null;
      openGame(gameId, f.color !== 'random' ? f.color : null);
    }
  } catch (e) {
    S.waiting = null;
    toast(e.message || 'Nie udało się rozpocząć partii.');
    render();
  }
}

async function acceptChallenge(id) {
  unlockMedia();
  const c = S.challenges.get(id);
  S.waiting = { text: `Przyjmuję wyzwanie${c ? ' od ' + c.from : ''}…`, kind: 'accept' };
  render();
  try {
    await S.provider.acceptChallenge(id);
    S.challenges.delete(id);
    setTimeout(() => { if (S.waiting?.kind === 'accept') { S.waiting = null; render(); refreshOngoing(); } }, 8000);
  } catch (e) {
    S.waiting = null; toast(e.message); render();
  }
}
async function declineChallenge(id) {
  try { await S.provider.declineChallenge(id); } catch (e) { toast(e.message); }
  S.challenges.delete(id);
  render();
}

// ---------------------------------------------------------------------------
// Partia
// ---------------------------------------------------------------------------
function applyUci(chess, uci) {
  const from = uci.slice(0, 2);
  let to = uci.slice(2, 4);
  const promotion = uci[4];
  const piece = chess.get(from);
  const target = chess.get(to);
  // Lichess może zapisać roszadę jako „król na wieżę” (e1h1) – zamiana na e1g1 / e1c1
  if (piece && piece.type === 'k' && target && target.type === 'r' && target.color === piece.color) {
    to = (to[0] > from[0] ? 'g' : 'c') + from[1];
  }
  return chess.move({ from, to, promotion });
}

function gameOver(G) { return !!G.state && G.state.status !== 'started' && G.state.status !== 'created'; }
function myTurn(G) { return !G.spectator && !!G.chess && !gameOver(G) && G.chess.turn() === G.myColor[0]; }

function openGame(id, colorHint) {
  closeGame();
  const info = S.ongoing.find((g) => g.id === id);
  const G = {
    id,
    colorHint: colorHint || info?.color || null,
    myColor: colorHint || info?.color || 'white',
    full: null, state: null, chess: null, history: [],
    lastSeenPly: null, conn: true, opponentGone: null, error: '',
    clockAt: performance.now(), stream: null, announcedEnd: false,
  };
  S.game = G;
  S.view = 'game';
  resetEntry(); S.sending = false; S.entryMsg = '';
  render();
  G.stream = S.provider.streamGame(id, (msg) => onGameMsg(G, msg));
  requestWakeLock();
}

function closeGame() {
  if (S.game?.stream) S.game.stream.close();
  S.game = null;
  releaseWakeLock();
}

function resolveMyColor(G, full) {
  const uid = (S.user?.id || '').toLowerCase();
  if (full.white?.id && full.white.id.toLowerCase() === uid) return 'white';
  if (full.black?.id && full.black.id.toLowerCase() === uid) return 'black';
  if (full.white?.ai) return 'black';
  if (full.black?.ai) return 'white';
  return G.colorHint || 'white';
}

function rebuild(G) {
  const fen = G.full && G.full.initialFen && G.full.initialFen !== 'startpos' ? G.full.initialFen : undefined;
  const chess = new Chess(fen);
  for (const uci of G.state.moves) {
    try { applyUci(chess, uci); } catch (e) { console.warn('bad move from server', uci, e); break; }
  }
  G.chess = chess;
  G.history = chess.history({ verbose: true });
}

// Odmowa cofnięcia / remisu albo wygaśnięcie prośby, bo rywal zagrał — gracz ma o tym wiedzieć.
function announceDeclines(G, prev, prevPly) {
  const my = G.myColor === 'white' ? 'w' : 'b';
  const last = G.history[G.history.length - 1];
  const oppMoved = G.history.length > prevPly && last && last.color !== my;
  const iMoved = G.history.length > prevPly && last && last.color === my;
  const check = (flag, cancelledKey, declined, expired) => {
    if (!prev[flag] || G.state[flag]) return;
    if (S[cancelledKey]) { S[cancelledKey] = false; return; }
    if (iMoved || G.history.length < prevPly) return; // własny ruch albo przyjęte cofnięcie
    toast(oppMoved ? expired : declined, 5000);
    if (!oppMoved) { beep(); vibrate([60, 40, 60]); speak(declined); }
  };
  check(my + 'takeback', 'tbCancelled', 'Rywal odmówił cofnięcia ruchu. Gra toczy się dalej.', 'Prośba o cofnięcie wygasła — rywal zagrał.');
  check(my + 'draw', 'drawCancelled', 'Rywal odrzucił remis.', 'Propozycja remisu wygasła — rywal zagrał.');
}

function onGameMsg(G, msg) {
  if (S.game !== G) return;
  switch (msg.type) {
    case 'full':
      G.full = msg;
      G.ratingResult = msg.ratingResult || null;
      G.spectator = !!msg.spectator; // trener ogląda cudzą partię
      G.myColor = G.spectator ? 'white' : resolveMyColor(G, msg);
      G.state = msg.state;
      G.clockAt = performance.now();
      rebuild(G);
      G.lastSeenPly = G.history.length;
      if (gameOver(G)) G.announcedEnd = true;
      render();
      break;
    case 'state': {
      const prevPly = G.history.length;
      const prevHistory = G.history;
      const prevState = G.state;
      const wasOver = gameOver(G);
      G.state = msg.state;
      G.clockAt = performance.now();
      rebuild(G);
      if (!G.spectator && prevState && !gameOver(G)) announceDeclines(G, prevState, prevPly);
      if (G.history.length > prevPly) {
        const last = G.history[G.history.length - 1];
        if (!G.spectator && last.color !== G.myColor[0]) {
          speak(speechForMove(last));
          vibrate([80, 60, 80]);
          beep();
        }
        resetEntry(); S.entryMsg = '';
        G.opponentGone = null;
      }
      if (G.history.length < prevPly) {
        // cofnięcie ruchu: powiedz, które ruchy zniknęły, żeby poprawić bierki na szachownicy
        const undone = prevHistory.slice(G.history.length).map((m) => fmtSan(m.san)).join(', ');
        resetEntry();
        S.entryMsg = `Cofnięto: ${undone}. Ustaw bierki z powrotem na szachownicy.`;
        speak(`Cofnięto ruch. Ustaw bierki z powrotem.`);
        vibrate([60, 40, 60]);
      }
      G.lastSeenPly = G.history.length;
      if (!wasOver && gameOver(G) && !G.announcedEnd) {
        G.announcedEnd = true;
        releaseWakeLock();
        speak(resultText(G).title + '.');
      }
      render();
      break;
    }
    case 'opponentGone': {
      const was = G.opponentGone;
      if (msg.gone) {
        // termin liczymy od chwili odebrania — odliczanie na żywo w updateClocks()
        G.opponentGone = { ...msg, deadline: Date.now() + (msg.claimWinInSeconds || 0) * 1000 };
        if (!was) { beep(); vibrate([200, 100, 200]); speak('Rywal opuścił partię.'); }
      } else {
        G.opponentGone = null;
        if (was) { toast('Rywal wrócił do partii.'); beep(); }
      }
      render();
      break;
    }
    case 'rating':
      G.ratingResult = msg.result;
      render();
      break;
    case 'connection':
      G.conn = msg.ok;
      render();
      break;
    case 'error':
      G.error = msg.message;
      render();
      break;
    case 'end':
      refreshOngoing();
      break;
    default: break;
  }
}

function resultText(G) {
  const st = G.state;
  if (!st) return { title: '', sub: '' };
  const sub = statusPl(st.status);
  if (st.status === 'aborted' || st.status === 'noStart') return { title: 'Partia przerwana', sub: '' };
  if (st.winner) return { title: st.winner === G.myColor ? 'Wygrana' : 'Przegrana', sub };
  return { title: 'Remis', sub: sub === 'Remis' ? '' : sub };
}

// --- wpisywanie ruchu --------------------------------------------------------
// Notacja (domyślnie): oficjalny zapis turniejowy (SAN, angielskie litery), np. e4, Nf3, exd5, Nbd7, e8=Q, O-O.
//   Przy niejednoznacznym ruchu aplikacja nie dopytuje — podpowiada, jak dopisać kolumnę lub rząd (Nbd7).
// Pola: skąd → dokąd (np. e2 e4).
const PIECE_NAME = { p: 'Pion', n: 'Skoczek', b: 'Goniec', r: 'Wieża', q: 'Hetman', k: 'Król' };
// [litera w zapisie, polska nazwa, polska litera]
const SAN_PIECES = [['K', 'król', 'K'], ['Q', 'hetman', 'H'], ['R', 'wieża', 'W'], ['B', 'goniec', 'G'], ['N', 'skoczek', 'S']];
const PL_TO_EN = { K: 'K', H: 'Q', W: 'R', G: 'B', S: 'N' };
function sanEntry() { return S.settings.sanEntry !== false; }
function englishLetters() { return S.settings.englishNotation !== false; }
function fmtSan(san) { return englishLetters() ? san : sanToPl(san); }
function nextSlotKind() { return S.input.length % 2 === 0 ? 'file' : 'rank'; }
function resetEntry() { S.input = []; S.promo = null; S.san = ''; }

// --- notacja ---
// Klucz porównania: bez znaków bicia, szacha, „=” i myślników; 0/o w roszadzie = O.
const sanKey = (s) => String(s).replace(/[x+#=!?\-\s]/g, '').replace(/[0o]/g, 'O');
const SAN_RE = /^([KQRBN])?([a-h])?([1-8])?([a-h][1-8])([QRBN])?$/;

// Dopasowanie wpisu do ruchów dozwolonych w pozycji.
// state: empty | ok (move) | partial (hints) | ambiguous (msg, hints) | promo (msg) | bad (msg)
function sanMatch(input) {
  const G = S.game;
  const key = sanKey(input || '');
  if (!key) return { state: 'empty' };
  const legal = G.chess.moves({ verbose: true });
  const exact = legal.filter((m) => sanKey(m.san) === key);
  if (exact.length === 1) return { state: 'ok', move: exact[0] };
  const prefix = [...new Set(legal.filter((m) => sanKey(m.san).startsWith(key)).map((m) => m.san))];
  if (/^O+$/.test(key)) {
    return prefix.length ? { state: 'partial', hints: prefix } : { state: 'bad', msg: 'Roszada nie jest teraz możliwa.' };
  }
  const p = key.match(SAN_RE);
  const none = () => (prefix.length ? { state: 'partial', hints: prefix } : { state: 'bad', msg: 'Nie ma takiego ruchu w tej pozycji.' });
  if (!p) return none();
  const [, piece, file, rank, to, promo] = p;
  // pobłażliwie: zbędne dookreślenie (Ngf3) albo bicie pionem bez kolumny (d5 zamiast exd5) też przejdzie
  const c = legal.filter((m) => m.piece === (piece ? piece.toLowerCase() : 'p') && m.to === to
    && (!file || m.from[0] === file) && (!rank || m.from[1] === rank)
    && (!promo || m.promotion === promo.toLowerCase()));
  if (!c.length) return none();
  const sans = [...new Set(c.map((m) => m.san))];
  if (new Set(c.map((m) => m.from)).size > 1) {
    return { state: 'ambiguous', hints: sans, msg: `Na ${to} mogą pójść: ${sans.map(fmtSan).join(', ')} — dopisz kolumnę lub rząd, skąd rusza figura.` };
  }
  if (c.length > 1) return { state: 'promo', msg: `Dopisz figurę promocji: ${to}=Q (hetman), =R (wieża), =B (goniec), =N (skoczek).` };
  return { state: 'ok', move: c[0] };
}

function pressSan(tok) {
  const G = S.game;
  if (!G || !myTurn(G) || S.sending) return;
  if (tok === 'O-O' || tok === 'O-O-O') S.san = tok;
  else if (S.san.length < 8) S.san += tok;
  S.entryMsg = '';
  const r = sanMatch(S.san);
  // „wysyłaj od razu”: tylko gdy wpis nie jest początkiem dłuższego ruchu (np. O-O i O-O-O)
  if (r.state === 'ok' && S.settings.autoSend) {
    const k = sanKey(S.san);
    if (!G.chess.moves().some((s) => sanKey(s) !== k && sanKey(s).startsWith(k))) { renderEntry(); sendMove(); return; }
  }
  renderEntry();
}

// --- pola: skąd → dokąd ---
function pressKey(ch) {
  const G = S.game;
  if (!G || !myTurn(G) || S.sending || S.promo) return;
  if (S.input.length >= 4) return;
  const kind = nextSlotKind();
  if (kind === 'file' && !FILES.includes(ch)) return;
  if (kind === 'rank' && !RANKS.includes(ch)) return;
  S.input.push(ch);
  S.entryMsg = '';
  if (S.input.length === 2 && hintsOn(G)) {
    const from = S.input.join('');
    const own = G.chess.get(from);
    if (!own || own.color !== G.myColor[0]) S.entryMsg = 'Na tym polu nie ma Twojej bierki.';
    else if (!G.chess.moves({ square: from, verbose: true }).length) S.entryMsg = 'Ta bierka nie ma teraz ruchu.';
  }
  if (S.input.length === 4) {
    const check = validateInput();
    if (!check.ok) { if (hintsOn(G)) S.entryMsg = check.msg; }
    else if (check.promotion) S.promo = { from: check.from, to: check.to };
    else if (S.settings.autoSend) { renderEntry(); sendMove(); return; }
  }
  renderEntry();
}
// Podpowiedzi przy wpisywaniu („Tryb nauki”): tylko w partiach towarzyskich i tylko po włączeniu w Ustawieniach.
function hintsOn(G) { return !!S.settings.learnMode && !!G?.full && !G.full.rated; }
// Ogólny komunikat po „Wyślij” bez podpowiadania, które figury wchodzą w grę.
function plainError(r) {
  if (r.state === 'ambiguous') return 'Ruch niejednoznaczny — dopisz kolumnę lub rząd, z którego rusza figura.';
  if (r.state === 'promo') return 'Dopisz figurę promocji: =Q, =R, =B albo =N.';
  return 'Niepoprawny ruch — sprawdź zapis.';
}
function backspace() {
  if (S.sending) return;
  if (sanEntry()) {
    S.san = /O-O(-O)?$/.test(S.san) ? '' : S.san.slice(0, -1);
  } else {
    if (S.promo) { S.promo = null; }
    S.input.pop();
  }
  S.entryMsg = '';
  renderEntry();
}
function clearInput() { if (S.sending) return; resetEntry(); S.entryMsg = ''; renderEntry(); }

function validateInput() {
  const G = S.game;
  const from = S.input.slice(0, 2).join('');
  const to = S.input.slice(2, 4).join('');
  const cands = G.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!cands.length) {
    const own = G.chess.get(from);
    if (!own || own.color !== G.myColor[0]) return { ok: false, msg: 'Na polu ' + from + ' nie ma Twojej bierki.' };
    return { ok: false, msg: `Ruch ${from}–${to} jest niedozwolony w tej pozycji.` };
  }
  return { ok: true, from, to, promotion: cands.some((m) => m.promotion) };
}

async function sendMove(promoPiece) {
  const G = S.game;
  if (!G || !myTurn(G) || S.sending) return;
  let uci;
  if (sanEntry()) {
    const r = sanMatch(S.san);
    if (r.state !== 'ok') { S.entryMsg = hintsOn(G) ? (r.msg || 'Zapisz ruch, np. e4 albo Nf3.') : plainError(r); renderEntry(); return; }
    uci = r.move.from + r.move.to + (r.move.promotion || '');
  } else {
    if (S.input.length !== 4) { S.entryMsg = 'Wpisz pole startowe i docelowe, np. e2 e4.'; renderEntry(); return; }
    const check = validateInput();
    if (!check.ok) { S.entryMsg = hintsOn(G) ? check.msg : 'Niepoprawny ruch — sprawdź pola.'; renderEntry(); return; }
    if (check.promotion && !promoPiece) { S.promo = { from: check.from, to: check.to }; renderEntry(); return; }
    uci = check.from + check.to + (promoPiece || '');
  }
  S.sending = true; S.entryMsg = 'Wysyłanie…'; S.promo = null;
  renderEntry();
  try {
    await S.provider.move(G.id, uci);
    if (S.game === G) { resetEntry(); S.entryMsg = ''; }
  } catch (e) {
    if (S.game === G) S.entryMsg = e.message || 'Nie udało się wysłać ruchu.';
  } finally {
    S.sending = false;
    if (S.game === G) render();
  }
}

// ---------------------------------------------------------------------------
// Widoki
// ---------------------------------------------------------------------------
function render() {
  const active = document.activeElement;
  const focusId = active && active.id && app.contains(active) ? active.id : null;
  const selStart = focusId && 'selectionStart' in active ? active.selectionStart : null;

  let html = '';
  if (S.view === 'loading') html = viewLoading();
  else if (S.view === 'start') html = viewStart();
  else if (S.view === 'room-new') html = viewRoomNew();
  else if (S.view === 'club-join') html = viewClubJoin();
  else if (S.view === 'account') html = viewAccount();
  else if (S.view === 'lobby') html = viewLobby();
  else if (S.view === 'game') html = viewGame();
  else if (S.view === 'coach') html = viewCoach();
  html += viewWaiting() + viewModal();
  app.innerHTML = html;

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (selStart != null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selStart); } catch {} } }
  }
  updateClocks();
}

function viewLoading() {
  return `<main class="center"><p class="muted">Łączenie…</p></main>`;
}

function viewLichessLogin(primary) {
  const cls = primary ? 'btn primary big' : 'btn big';
  if (CONFIG.DEMO_ONLY) {
    return `<p class="note">To jest podgląd. Logowanie przez Lichess zadziała, gdy aplikacja będzie wgrana pod własny adres (instrukcja w README).</p>`;
  }
  return new LichessProvider().hasToken()
    ? `<button class="${cls}" data-action="lichess-resume">Graj przez Lichess</button>
       <button class="link" data-action="lichess-logout">Wyloguj z Lichess</button>`
    : `<button class="${cls}" data-action="login">Zaloguj przez Lichess</button>
       <button class="link" data-action="token-login">Inny sposób: wklej token Lichess</button>`;
}

function viewStart() {
  const err = S.startError ? `<p class="error">${esc(S.startError)}</p>` : '';
  const brand = `
    <div class="brand">
      <div class="logo" aria-hidden="true">e2·e4</div>
      <h1>${esc(CONFIG.APP_NAME)}</h1>
    </div>`;
  if (!roomsEnabled()) {
    // wariant A: bez serwera pokoi
    return `
  <main class="start">
    ${brand}
    <p class="lead">Grasz na prawdziwej szachownicy. Tutaj tylko wpisujesz swój ruch i odczytujesz ruch rywala — bez szachownicy na ekranie.</p>
    <p class="muted small">Partie i ranking są na Twoim koncie Lichess.</p>
    ${err}
    <div class="stack">
      ${viewLichessLogin(true)}
      <button class="btn big" data-action="demo">Wypróbuj bez logowania</button>
    </div>
    <p class="muted small">Tempa od 10 minut — żeby był czas zagrać ruch na szachownicy i go wpisać. Przez Lichess: rapid, klasyczne i korespondencja.</p>
    ${viewBanner()}
  </main>`;
  }
  const acct = savedAccount();
  const clubs = myClubs();
  const who = acct
    ? `<p class="account-line">Grasz jako <strong>${esc(acct.nick)}</strong>${acct.secured ? '' : ' · <span class="warn">konto bez hasła</span>'}
         <button class="link small" data-action="account-menu">Konto</button></p>`
    : `<p class="account-line muted small">Konto trzyma ranking, znajomych i kluby na każdym urządzeniu. <button class="link small" data-action="account-login">Mam konto — zaloguj się</button></p>`;
  const hint = S.standaloneHint ? `
    <div class="notice">Aplikacja z ekranu głównego ma osobną pamięć od przeglądarki. Zaloguj się tu raz — zapamięta Cię.
      Klub z innego urządzenia przeniesiesz 6-cyfrowym kodem (niżej). <button class="link small" data-action="hide-standalone">OK</button></div>` : '';
  const clubsCard = clubs.length ? `
    <section class="card mode-card">
      <h2>Moje kluby</h2>
      <div class="stack">${clubs.map((c) => `
        <button class="btn big mode-btn" data-action="open-club" data-id="${esc(c.room)}">👥 ${esc(c.name)}<span class="mode-sub">${c.here ? `jako ${esc(c.nick)}` : 'zapisany na koncie — otwórz'}</span></button>`).join('')}
      </div>
      <p class="small"><button class="link" data-action="club-join-open">Dołącz do innego klubu</button> · <button class="link" data-action="room-new">Załóż klub</button></p>
    </section>` : '';
  return `
  <main class="start">
    ${brand}
    <p class="lead">Grasz na prawdziwej szachownicy. Tu tylko wpisujesz swój ruch i słyszysz ruch rywala.</p>
    ${err}
    ${hint}
    <section class="card mode-card">
      <h2>Bez konta Lichess</h2>
      ${who}
      <div class="stack">
        <button class="btn primary big mode-btn" data-action="quick-play">⚡ Szybka gra<span class="mode-sub">dobór rywala online, znajomi, ranking ogólny</span></button>
        ${clubs.length ? '' : `<button class="btn big mode-btn" data-action="club-join-open">🔑 Dołącz do klubu<span class="mode-sub">masz kod klubu, np. HETMA-7Q4MX</span></button>
        <button class="link small" data-action="room-new">Załóż klub (dla znajomych, klubu, szkółki)</button>`}
      </div>
    </section>
    ${clubsCard}
    <details class="card transfer-card" ${S.transferOpen ? 'open' : ''}>
      <summary>Mam kod przeniesienia z innego urządzenia</summary>
      <form data-form="transfer" class="inline-form" autocomplete="off">
        <input id="transfer-code" type="text" inputmode="numeric" maxlength="7" pattern="[0-9 ]*" placeholder="6 cyfr" aria-label="Kod przeniesienia">
        <button type="submit" class="btn small primary">Przenieś</button>
      </form>
      <p class="muted small">Kod ważny 10 minut. Utworzysz go na starym urządzeniu: Konto albo Klub → Inne urządzenie.</p>
    </details>
    <section class="card mode-card">
      <h2>Przez Lichess</h2>
      <p class="muted small">Partie i ranking na Twoim koncie Lichess. Losowi rywale: rapid i dłużej.</p>
      <div class="stack">${viewLichessLogin(false)}</div>
    </section>
    <p class="center-text small"><button class="link" data-action="demo">Wypróbuj z komputerem (demo)</button> · <a href="kluby.html">Dla klubów i trenerów</a></p>
  </main>`;
}

const PRIVACY_LINK = `<a href="prywatnosc.html" target="_blank" rel="noopener">Prywatność</a>`;
const NICK_INPUT = (value, placeholder) => `<input id="room-nick" name="username" type="text" maxlength="20" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(value)}" placeholder="${placeholder}">`;

// Konto: rejestracja / logowanie / nie pamiętam hasła / nowe hasło z linku.
function viewAccount() {
  const f = S.accountForm;
  const back = `<header class="g-top"><button class="btn small" data-action="to-start">← Wróć</button></header>`;
  const pass = (id, label, auto) => `
    <label class="field">${label}
      <input id="${id}" name="password" type="password" autocomplete="${auto}" value="">
    </label>`;
  // prawdziwe formularze <form> — iPhone (Pęk kluczy) i menedżery haseł proponują wtedy zapisanie hasła
  const form = (mode, inner) => `<form data-form="account" data-mode="${mode}" method="post" action="#">${inner}</form>`;
  if (f.mode === 'forgot') {
    return `
  <main class="start">${back}
    <h1>Nie pamiętam hasła</h1>
    <p class="lead">Wyślemy link do ustawienia nowego hasła na e-mail podany przy koncie.</p>
    ${form('forgot', `
    <label class="field">Nick albo e-mail
      <input id="acct-login" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(f.nick)}">
    </label>
    ${f.info ? `<p class="note small">${esc(f.info)}</p>` : ''}
    <div class="stack"><button type="submit" class="btn primary big">Wyślij link</button></div>`)}
    <p class="small"><button class="link" data-action="acct-mode" data-id="login">← Wróć do logowania</button></p>
  </main>`;
  }
  if (f.mode === 'reset') {
    return `
  <main class="start">${back}
    <h1>Nowe hasło</h1>
    ${form('reset', `
    ${pass('acct-pass', 'Nowe hasło (min. 8 znaków)', 'new-password')}
    <div class="stack"><button type="submit" class="btn primary big">Ustaw hasło i zaloguj</button></div>`)}
  </main>`;
  }
  if (f.mode === 'login') {
    return `
  <main class="start">${back}
    <h1>Zaloguj się</h1>
    <p class="lead">Twój ranking, znajomi i kluby wrócą na tym urządzeniu.</p>
    ${form('login', `
    <label class="field">Nick ${NICK_INPUT(f.nick, '')}</label>
    ${pass('acct-pass', 'Hasło', 'current-password')}
    <div class="stack"><button type="submit" class="btn primary big">Zaloguj się</button></div>`)}
    <p class="small"><button class="link" data-action="acct-mode" data-id="forgot">Nie pamiętam hasła</button></p>
    <p class="small">Nie masz konta? <button class="link" data-action="acct-mode" data-id="register">Załóż konto</button></p>
  </main>`;
  }
  return `
  <main class="start">${back}
    <h1>Załóż konto</h1>
    <p class="lead">Konto trzyma ranking, znajomych i kluby — zalogujesz się na każdym urządzeniu. Bez konta Lichess.</p>
    ${form('register', `
    <label class="field">Nick (widoczny dla innych graczy) ${NICK_INPUT(f.nick, 'np. Ania_K')}</label>
    ${pass('acct-pass', 'Hasło (min. 8 znaków)', 'new-password')}
    <p class="note small">Wymyśl <strong>nowe hasło, którego nie używasz nigdzie indziej</strong> (np. do poczty czy banku). Najlepiej kilka słów, np. „zielony-goniec-na-b5”. Zbyt popularnych haseł aplikacja nie przyjmie.</p>
    <label class="field">E-mail <span class="muted">(nieobowiązkowy — tylko do odzyskania hasła)</span>
      <input id="acct-email" name="email" type="email" autocomplete="email" inputmode="email" value="${esc(f.email)}" placeholder="adres@e-mail.pl">
    </label>
    <div class="stack"><button type="submit" class="btn primary big">Załóż konto</button></div>`)}
    <p class="small">Masz już konto? <button class="link" data-action="acct-mode" data-id="login">Zaloguj się</button></p>
    <p class="note small">W szybkiej grze grasz z nieznajomymi. Nie da się sprawdzić, czy ktoś gra przy szachownicy, czy z programem — z kimś, komu ufasz, zagrasz w klubie.</p>
    <p class="muted small">Zapisujemy nick, skrót hasła (nie samo hasło), e-mail tylko jeśli go podasz, partie, ranking i listę znajomych. ${PRIVACY_LINK}</p>
  </main>`;
}

function viewRoomNew() {
  const f = S.roomForm;
  const acct = savedAccount();
  return `
  <main class="start">
    <header class="g-top"><button class="btn small" data-action="to-start">← Wróć</button></header>
    <h1>Nowy klub</h1>
    <p class="lead">Zamknięta grupa dla znajomych, klubu albo szkółki. Ranking jest wspólny z poczekalnią ogólną (jeden na tempo).</p>
    <form data-form="room-new" autocomplete="off">
      <label class="field">Nazwa klubu
        <input id="room-name" type="text" maxlength="40" autocomplete="off" value="${esc(f.name)}" placeholder="np. Klub Hetman — środy">
      </label>
      <label class="field">Twój nick w klubie ${NICK_INPUT(f.nick || acct?.nick || '', 'np. Ania')}</label>
      ${acct ? `<p class="muted small">Klub zapisze się na koncie ${esc(acct.nick)} — wrócisz do niego po zalogowaniu na innym urządzeniu.</p>`
    : `<p class="note small">Bez konta partie w klubie są tylko towarzyskie. Rankingowe wymagają konta u obojga graczy.</p>`}
      <div class="stack"><button type="submit" class="btn primary big">Załóż klub</button></div>
    </form>
    <p class="muted small">Dostaniesz kod klubu (np. HETMA-7Q4MX) i link do wysłania. Możesz później zmienić kod i dodać hasło klubu.</p>
    <p class="muted small">Zapisujemy tylko nick, przynależność do klubu i partie. ${PRIVACY_LINK}</p>
  </main>`;
}

// Dołączanie do klubu: kod → (nazwa klubu) → nick i ewentualnie hasło klubu.
function viewClubJoin() {
  const j = S.joinRoom || { code: '' };
  const f = S.roomForm;
  const acct = savedAccount();
  const step2 = j.checked ? `
      <p class="lead">Klub <strong>${esc(j.name)}</strong></p>
      <label class="field">Twój nick w klubie ${NICK_INPUT(f.nick || acct?.nick || '', 'np. Bartek')}</label>
      ${j.needsPassword ? `<label class="field">Hasło klubu <input id="club-pass" type="password" autocomplete="off"></label>` : ''}
      ${acct ? `<p class="muted small">Klub zapisze się na koncie ${esc(acct.nick)}.</p>` : `<p class="muted small">Bez konta urządzenie zapamięta Cię w klubie; partie rankingowe wymagają konta.</p>`}
      <div class="stack"><button type="submit" class="btn primary big">Dołącz</button></div>` : `
      <div class="stack"><button type="submit" class="btn primary big">Dalej</button></div>`;
  return `
  <main class="start">
    <header class="g-top"><button class="btn small" data-action="to-start">← Wróć</button></header>
    <h1>Dołącz do klubu</h1>
    <form data-form="club-join" autocomplete="off">
      <label class="field">Kod klubu
        <input id="club-code" type="text" maxlength="16" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${esc(j.code)}" placeholder="np. HETMA-7Q4MX" ${j.checked ? 'readonly' : ''}>
      </label>
      ${j.checked ? `<p class="small"><button type="button" class="link" data-action="club-code-change">Inny kod</button></p>` : ''}
      ${j.error ? `<p class="error">${esc(j.error)}</p>` : ''}
      ${step2}
    </form>
    <p class="muted small">Kod dostaniesz od założyciela klubu albo trenera. Po kilku błędnych próbach dołączanie do klubów zostaje zablokowane na pewien czas. ${PRIVACY_LINK}</p>
  </main>`;
}

const RATING_SPEEDS = [['rapid', 'Rapid'], ['classical', 'Klasyczne']]; // blitzu nie ma (tempa od 10 minut)
function roomRatings(r) {
  return { blitz: r?.blitz?.rating, rapid: r?.rapid?.rating, classical: r?.classical?.rating };
}
function roomRating(r) {
  if (!r) return '—';
  return `${r.rating}${r.provisional ? '?' : ''}`;
}

function ratingsLine() {
  if (S.provider?.features?.rooms) {
    const r = S.provider.me?.ratings || {};
    return RATING_SPEEDS.filter(([k]) => r[k]?.games).map(([k, l]) => `${l} ${roomRating(r[k])}`).join(' · ')
      || 'Ranking pojawi się po pierwszej partii rankingowej';
  }
  const r = S.user?.ratings || {};
  const parts = [];
  if (r.rapid) parts.push(`Rapid ${r.rapid}`);
  if (r.classical) parts.push(`Klasyczne ${r.classical}`);
  if (r.correspondence) parts.push(`Koresp. ${r.correspondence}`);
  return parts.join(' · ');
}

function viewLobby() {
  const demo = S.provider?.isDemo;
  const ongoing = S.ongoing.length
    ? S.ongoing.map((g) => `
      <button class="row" data-action="open-game" data-id="${esc(g.id)}">
        <span class="row-main">${esc(g.opponent.name)}${g.opponent.rating ? ` <span class="muted">(${g.opponent.rating})</span>` : ''}</span>
        <span class="row-sub">${esc(SPEED_PL[g.speed] || g.speed || '')} · grasz ${g.color === 'white' ? 'białymi' : 'czarnymi'}</span>
        <span class="pill ${g.isMyTurn ? 'pill-on' : ''}">${g.isMyTurn ? 'Twój ruch' : 'czekasz'}</span>
      </button>`).join('')
    : `<p class="muted small">Brak trwających partii.</p>`;

  const chal = [...S.challenges.values()];
  const challenges = chal.length ? `
    <section class="card">
      <h2>Wyzwania</h2>
      ${chal.map((c) => `
        <div class="row static">
          <span class="row-main">${esc(c.from)}${c.rating ? ` <span class="muted">(${c.rating})</span>` : ''}</span>
          <span class="row-sub">${esc(SPEED_PL[c.speed] || c.speed)} ${esc(c.label)}${c.rated ? ' · rankingowa' : ''}</span>
          ${c.compatible
            ? `<span class="row-actions"><button class="btn small primary" data-action="accept" data-id="${esc(c.id)}">Przyjmij</button><button class="btn small" data-action="decline" data-id="${esc(c.id)}">Odrzuć</button></span>`
            : `<span class="row-sub warn">Tego tempa lub wariantu nie da się grać przez API.</span><span class="row-actions"><button class="btn small" data-action="decline" data-id="${esc(c.id)}">Odrzuć</button></span>`}
        </div>`).join('')}
    </section>` : '';

  const rooms = !!S.provider?.features?.rooms;
  return `
  <main class="lobby">
    <header class="topbar">
      <div>
        <div class="who">${esc(S.user?.name || '')}${demo ? ' <span class="pill">demo</span>' : ''}${rooms ? ` <span class="muted">· ${esc(S.provider.roomName)}</span>` : ''}</div>
        <div class="muted small">${esc(ratingsLine()) || (demo ? 'Tryb demo — bez rankingu' : '')}</div>
      </div>
      <div class="topbar-actions">
        <span class="dot ${S.online ? 'on' : 'off'}" title="${S.online ? 'Połączono' : 'Łączenie…'}"></span>
        ${rooms ? `<button class="icon-btn" data-action="room-menu" aria-label="${S.provider.isPublic ? 'Konto' : 'Klub'}">⌂</button>` : ''}
        <button class="icon-btn" data-action="settings" aria-label="Ustawienia">⚙︎</button>
        ${rooms ? '' : `<button class="icon-btn" data-action="logout" aria-label="Wyloguj">⏻</button>`}
        <button class="btn small" data-action="to-menu">Menu</button>
      </div>
    </header>

    ${!S.online && rooms ? `<div class="notice">Brak połączenia z serwerem — łączę ponownie…</div>` : ''}
    ${rooms && S.provider.isPublic && S.provider.me && !S.provider.me.hasPassword
    ? `<div class="notice">Konto bez hasła — ranking jest tylko na tym urządzeniu. <button class="btn small primary" data-action="secure-open">Ustaw hasło</button></div>` : ''}

    ${challenges}

    <section class="card">
      <h2>Trwające partie</h2>
      ${ongoing}
    </section>

    ${viewNewGame()}

    ${rooms && S.provider.isPublic ? viewFriends() : ''}
    ${rooms && isCoach() ? `<section class="card"><h2>Panel trenera</h2>
      <p class="muted small">Jako ${S.provider.me?.role === 'owner' ? 'założyciel' : 'administrator'} klubu widzisz partie wszystkich członków (podgląd na żywo, wyniki, zapis do analizy) i zarządzasz członkami.</p>
      <button class="btn small primary" data-action="coach-open">Otwórz panel trenera</button></section>` : ''}
    ${rooms ? viewRoomRanking() + viewRoomHistory() : viewBanner()}
  </main>`;
}

// --- wariant B: pokój ---------------------------------------------------------
function viewRoomRanking() {
  const pub = !!S.provider.features?.public;
  const members = S.provider.members || [];
  const sp = S.rankSpeed;
  const meId = S.user?.id;
  const sorted = [...members].sort((a, b) => {
    const ga = a.ratings?.[sp]?.games ? 1 : 0;
    const gb = b.ratings?.[sp]?.games ? 1 : 0;
    if (ga !== gb) return gb - ga;
    return (b.ratings?.[sp]?.rating || 0) - (a.ratings?.[sp]?.rating || 0) || a.nick.localeCompare(b.nick, 'pl');
  });
  const rows = sorted.map((m, i) => {
    const r = m.ratings?.[sp];
    return `
      <li class="rank-row ${m.id === meId ? 'me' : ''}">
        <span class="rank-n">${r?.games ? i + 1 + '.' : ''}</span>
        ${pub ? '' : `<span class="dot ${m.online ? 'on' : 'off'}" title="${m.online ? 'w klubie' : 'poza klubem'}"></span>`}
        <span class="rank-nick">${esc(m.nick)}${m.id === meId ? ' <span class="muted small">(Ty)</span>' : ''}</span>
        <span class="rank-r">${r?.games ? esc(roomRating(r)) : '<span class="muted small">—</span>'}</span>
        <span class="rank-g muted small">${r?.games || 0} p.</span>
      </li>`;
  }).join('');
  return `
  <section class="card">
    <h2>${pub ? 'Ranking ogólny' : 'Członkowie klubu'}</h2>
    <div class="tabs">${RATING_SPEEDS.map(([k, l]) => `<button class="tab ${sp === k ? 'sel' : ''}" data-action="rank-speed" data-id="${k}">${l}</button>`).join('')}</div>
    <ol class="rank-list">${rows}</ol>
    <p class="muted small">${pub ? 'Czołówka (20 najlepszych) i Ty. ' : 'Ranking jest wspólny dla poczekalni i wszystkich klubów (jeden na tempo, start 1200). '}„?” — ranking jeszcze niepewny (mało partii). Liczą się tylko partie rankingowe.</p>
    ${pub ? '' : `<button class="btn small" data-action="room-menu">Zaproś do klubu</button>`}
  </section>`;
}

const RESULT_PL = { white: '1–0', black: '0–1' };
function viewRoomHistory() {
  const h = S.roomHistory;
  let body;
  if (!h) body = `<p class="muted small">${S.historyLoading ? 'Wczytywanie…' : ''}</p>`;
  else if (!h.length) body = `<p class="muted small">Jeszcze nie rozegrano żadnej partii.</p>`;
  else {
    body = `<ul class="hist-list">${h.map((g) => {
      const res = g.status === 'aborted' || g.status === 'noStart' ? 'przerw.' : RESULT_PL[g.winner] || '½–½';
      const diff = (d) => (d == null ? '' : ` <span class="muted small">${d > 0 ? '+' : ''}${d}</span>`);
      return `<li>
        <span class="hist-players">${esc(g.white)}${diff(g.diffW)} – ${esc(g.black)}${diff(g.diffB)}</span>
        <span class="hist-res">${res}</span>
        <span class="muted small">${esc(SPEED_PL[g.speed] || g.speed)} ${esc(g.label)} · ${esc(statusPl(g.status))}${g.rated ? '' : ' · towarzyska'} · ${new Date(g.endedAt).toLocaleDateString('pl-PL')}${(isCoach() || g.whiteId === S.user?.id || g.blackId === S.user?.id) && g.plies
    ? ` · <button class="link small" data-action="game-analysis" data-id="${esc(g.id)}">analiza</button> · <button class="link small" data-action="game-pgn" data-id="${esc(g.id)}">PGN</button>` : ''}</span>
      </li>`;
    }).join('')}</ul>`;
  }
  return `
  <details class="card room-hist" data-action="room-history" ${S.roomHistoryOpen ? 'open' : ''}>
    <summary>${S.provider.features?.public ? 'Twoje partie' : 'Historia partii w klubie'}</summary>
    ${body}
  </details>`;
}

// --- znajomi (poczekalnia ogólna) ------------------------------------------------
function opponentsOnline() {
  const s = S.provider?.social;
  if (!s) return [];
  return [...(s.friends || []).map((p) => ({ ...p, friend: true })), ...(s.recent || [])].filter((p) => p.online);
}
function findPerson(id) {
  if (!id || !S.provider) return null;
  const s = S.provider.social || {};
  for (const list of [S.provider.members, s.friends, s.recent]) {
    const p = (list || []).find((x) => x.id === id);
    if (p) return S.provider.isPublic ? { ...p, account: true } : p;
  }
  return null;
}
// Dlaczego nie można zagrać rankingowo (pusty tekst = można).
function ratedBlockReason() {
  const p = S.provider;
  if (!p?.features?.rooms) return '';
  if (!p.me?.account) return 'Partie rankingowe wymagają konta — załóż je na ekranie startowym (Konto).';
  if (!p.isPublic && S.form.mode === 'member') {
    const opp = findPerson(S.form.opponent);
    if (opp && !opp.account) return `${opp.nick} nie ma konta — z tą osobą zagrasz tylko towarzysko.`;
  }
  return '';
}
function viewFriends() {
  const s = S.provider.social;
  if (!s) return `<section class="card"><h2>Znajomi</h2><p class="muted small">Wczytywanie…</p></section>`;
  const person = (p, actions) => `
    <li class="friend-row">
      <span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'online' : 'offline'}"></span>
      <span class="friend-nick">${esc(p.nick)}${p.rating ? ` <span class="muted small">(${p.rating})</span>` : ''}</span>
      <span class="row-actions">${actions}</span>
    </li>`;
  const btn = (action, id, label, cls = '') => `<button class="btn small ${cls}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
  const challenge = (p) => (p.online ? btn('friend-challenge', p.id, 'Wyzwij', 'primary') : '');
  const sec = (title, list, fn) => (list?.length ? `<h3>${title}</h3><ul class="friend-list">${list.map(fn).join('')}</ul>` : '');
  return `
  <section class="card friends">
    <h2>Znajomi</h2>
    ${sec('Zaproszenia do znajomych', s.incoming, (p) => person(p, btn('friend-accept', p.id, 'Przyjmij', 'primary') + btn('friend-decline', p.id, 'Odrzuć')))}
    ${s.friends?.length ? sec('Twoi znajomi', s.friends, (p) => person(p, challenge(p) + btn('friend-more', p.id, '⋯')))
    : `<p class="muted small">Nie masz jeszcze znajomych. Zaproś kogoś nickiem albo z listy ostatnich rywali.</p>`}
    ${sec('Ostatni rywale', s.recent, (p) => person(p, challenge(p) + btn('friend-invite-id', p.id, 'Zaproś') + btn('friend-block', p.id, 'Zablokuj')))}
    ${sec('Wysłane zaproszenia', s.outgoing, (p) => person(p, btn('friend-cancel', p.id, 'Anuluj')))}
    <form data-form="friend-add" class="inline-form" autocomplete="off">
      <input id="friend-nick" type="text" maxlength="20" autocapitalize="off" spellcheck="false" placeholder="Nick gracza" aria-label="Nick gracza do zaproszenia">
      <button type="submit" class="btn small">Zaproś do znajomych</button>
    </form>
    ${s.blocked?.length ? `<details class="blocked"><summary class="small">Zablokowani (${s.blocked.length})</summary>
      <ul class="friend-list">${s.blocked.map((p) => person({ ...p, online: false }, btn('friend-unblock', p.id, 'Odblokuj'))).join('')}</ul></details>` : ''}
    <p class="muted small">Zablokowana osoba nie może Cię wyzwać ani zaprosić. Nie dowie się o blokadzie.</p>
  </section>`;
}

function viewNewGame() {
  const f = S.form;
  const demo = S.provider?.isDemo;
  const rooms = !!S.provider?.features?.rooms;
  const pub = !!S.provider?.features?.public;
  const modes = demo
    ? [['ai', 'Komputer']]
    : pub ? [['seek', 'Poczekalnia'], ['member', 'Znajomi']]
      : rooms ? [['member', 'Członek klubu'], ['seek', 'Poczekalnia']]
        : [['seek', 'Losowy'], ['friend', 'Znajomy'], ['ai', 'Komputer']];
  if (!modes.find(([k]) => k === f.mode)) f.mode = modes[0][0];
  const allowed = PRESETS.filter((p) => !(rooms && p.days));
  if (!allowed.find((p) => p.id === f.preset)) f.preset = 'r10_5';
  const groups = [...new Set(allowed.map((p) => p.group))];
  const presetsHtml = groups.map((g) => `
    <div class="preset-group">
      <div class="muted small">${g}</div>
      <div class="chips">
        ${allowed.filter((p) => p.group === g).map((p) => `
          <button class="chip ${f.preset === p.id ? 'sel' : ''}" data-action="preset" data-id="${p.id}">${p.label}</button>`).join('')}
      </div>
    </div>`).join('');

  const friend = f.mode === 'friend' ? `
    <label class="field">Nick znajomego na Lichess
      <input id="friend-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(f.friend)}" placeholder="np. jan_kowalski">
    </label>` : '';
  let member = '';
  if (f.mode === 'member') {
    // poczekalnia: tylko znajomi i ostatni rywale, którzy są teraz online (bez listy wszystkich graczy)
    const others = pub ? opponentsOnline()
      : (S.provider.members || []).filter((m) => m.id !== S.user?.id)
        .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.nick.localeCompare(b.nick, 'pl'));
    if (!others.find((m) => m.id === f.opponent)) f.opponent = others.find((m) => m.online)?.id || others[0]?.id || '';
    member = others.length ? `
    <div class="field">Rywal
      <div class="chips">${others.map((m) => `<button class="chip ${f.opponent === m.id ? 'sel' : ''}" data-action="opponent" data-id="${esc(m.id)}"><span class="dot ${m.online ? 'on' : 'off'}"></span> ${esc(m.nick)}${m.friend ? ' ★' : ''}</button>`).join('')}</div>
    </div>`
      : pub ? `<p class="note small">Nikt ze znajomych ani ostatnich rywali nie jest teraz online. Dodaj znajomych niżej albo poszukaj rywala w zakładce „Poczekalnia”.</p>`
        : `<p class="note small">W klubie nie ma jeszcze nikogo poza Tobą. <button class="link" data-action="room-menu">Zaproś kogoś</button></p>`;
  }
  let seekList = '';
  if (rooms && f.mode === 'seek') {
    const seeks = (S.provider.seeks || []).filter((s) => s.memberId !== S.user?.id);
    seekList = `
    <div class="field">Czekają na rywala
      ${seeks.length ? `<ul class="seek-list">${seeks.map((s) => `
        <li>
          <span class="seek-who">${esc(s.nick)} <span class="muted">(${s.rating})</span></span>
          <span class="muted small">${esc(SPEED_PL[s.speed] || s.speed)} ${esc(s.label)}${s.rated ? ' · rankingowa' : ' · towarzyska'}</span>
          <button class="btn small primary" data-action="seek-accept" data-id="${esc(s.id)}">Graj</button>
        </li>`).join('')}</ul>`
    : `<p class="muted small">Nikt teraz nie czeka. Wybierz tempo i szukaj — aplikacja połączy Cię z pierwszą osobą, która wybierze to samo tempo.</p>`}
    </div>`;
  }
  const level = f.mode === 'ai' && !demo ? `
    <div class="field">Poziom komputera
      <div class="chips">${[1, 2, 3, 4, 5, 6, 7, 8].map((l) => `<button class="chip ${f.level === l ? 'sel' : ''}" data-action="level" data-id="${l}">${l}</button>`).join('')}</div>
    </div>` : '';
  const color = f.mode !== 'seek' ? `
    <div class="field">Kolor
      <div class="chips">${[['random', 'Losowo'], ['white', 'Białe'], ['black', 'Czarne']].map(([k, l]) => `<button class="chip ${f.color === k ? 'sel' : ''}" data-action="color" data-id="${k}">${l}</button>`).join('')}</div>
    </div>` : '';
  // rankingowa tylko, gdy oboje mają konto (w poczekalni ogólnej zawsze)
  const ratedBlock = ratedBlockReason();
  const rated = f.mode !== 'ai' ? `
    <label class="toggle ${ratedBlock ? 'disabled' : ''}"><input type="checkbox" data-action="rated" ${f.rated && !ratedBlock ? 'checked' : ''} ${ratedBlock ? 'disabled' : ''}> Partia rankingowa</label>
    ${ratedBlock ? `<p class="muted small">${esc(ratedBlock)}</p>` : f.rated ? '' : `<p class="muted small">Towarzyska: bez rankingu. W ustawieniach możesz włączyć „Tryb nauki” z podpowiedziami.</p>`}` : '';
  const label = f.mode === 'seek' ? 'Szukaj rywala' : f.mode === 'friend' || f.mode === 'member' ? 'Wyślij wyzwanie' : 'Zagraj z komputerem';

  return `
  <section class="card">
    <h2>Nowa partia</h2>
    <div class="tabs">${modes.map(([k, l]) => `<button class="tab ${f.mode === k ? 'sel' : ''}" data-action="mode" data-id="${k}">${l}</button>`).join('')}</div>
    ${friend}
    ${member}
    ${seekList}
    ${presetsHtml}
    ${level}
    ${color}
    ${rated}
    <button class="btn primary big" data-action="start-game">${label}</button>
  </section>`;
}

// --- głosowanie 👍/👎: „czy grałbyś z rankingiem bez konta Lichess?” ---------
function parseFeedbackLink(link) {
  try {
    const u = new URL(link);
    if (!/docs\.google\.com$/.test(u.hostname)) return null;
    const action = u.origin + u.pathname.replace(/\/viewform$/, '/formResponse');
    const map = {};
    for (const [k, v] of u.searchParams) {
      if (!k.startsWith('entry.')) continue;
      const t = v.trim().toUpperCase();
      if (t === 'GLOS' || t === 'GŁOS') map.vote = k;
      else if (t === 'EMAIL') map.email = k;
      else if (t === 'TRYB') map.mode = k;
    }
    return map.vote ? { action, ...map } : null;
  } catch { return null; }
}

async function sendFeedback(vote, email) {
  const f = parseFeedbackLink(CONFIG.FEEDBACK_FORM_LINK);
  if (!f) { toast('Głosowanie nie jest jeszcze podpięte (config.js).'); return false; }
  const body = new URLSearchParams();
  body.set(f.vote, vote);
  if (f.email && email) body.set(f.email, email);
  if (f.mode) body.set(f.mode, S.provider ? (S.provider.isDemo ? 'demo' : 'lichess') : 'niezalogowany');
  try {
    await fetch(f.action, { method: 'POST', mode: 'no-cors', body });
    return true;
  } catch {
    toast('Nie udało się wysłać — sprawdź internet i spróbuj ponownie.');
    return false;
  }
}

function viewBanner() {
  if (S.voted === 'done' || S.bannerHidden) return '';
  const head = `<p><strong>Grałbyś z rankingiem bez konta Lichess?</strong> Na przykład we własnych pokojach z klubem albo znajomymi. Takiej wersji jeszcze nie ma — sprawdzamy, czy jest potrzebna.</p>`;
  if (S.voted === 'up-pending') {
    return `
    <aside class="banner">
      ${head}
      <label class="field">Chcesz wiadomość, gdy powstanie? Zostaw e-mail (nieobowiązkowe)
        <input id="vote-email" type="email" autocomplete="email" inputmode="email" placeholder="adres@e-mail.pl" value="${esc(S.voteEmail || '')}">
      </label>
      <p class="muted small">E-mail posłuży tylko do tej jednej wiadomości.</p>
      <div class="row-actions">
        <button class="btn small primary" data-action="vote-send">Wyślij</button>
        <button class="btn small" data-action="vote-skip">Pomiń e-mail</button>
      </div>
    </aside>`;
  }
  return `
  <aside class="banner">
    ${head}
    <div class="vote">
      <button class="btn vote-btn" data-action="vote-up" aria-label="Tak">👍 Tak</button>
      <button class="btn vote-btn" data-action="vote-down" aria-label="Nie">👎 Nie</button>
    </div>
    <button class="link small" data-action="hide-banner">Nie pokazuj</button>
  </aside>`;
}

function viewGame() {
  const G = S.game;
  if (!G.full) {
    return `<main class="game"><header class="g-top"><button class="btn small" data-action="back">← Partie</button></header>
      <p class="muted center-text">${G.error ? esc(G.error) : 'Wczytywanie partii…'}</p></main>`;
  }
  const opp = G.myColor === 'white' ? G.full.black : G.full.white;
  const me = G.myColor === 'white' ? G.full.white : G.full.black;
  const tc = G.full.clock ? `${G.full.clock.initial / 60000}+${G.full.clock.increment / 1000}` : G.full.daysPerTurn ? `${G.full.daysPerTurn} d/ruch` : '';
  const meta = `${SPEED_PL[G.full.speed] || G.full.speed} ${tc}${G.full.rated ? ' · rankingowa' : ''}`;
  const over = gameOver(G);

  // ostatni ruch rywala (trener: ostatni ruch w ogóle)
  const spec = !!G.spectator;
  let lastOpp = null;
  for (let i = G.history.length - 1; i >= 0; i--) { if (spec || G.history[i].color !== G.myColor[0]) { lastOpp = { m: G.history[i], idx: i }; break; } }
  const lastBlock = lastOpp
    ? `<div class="lm-label">${spec ? 'Ostatni ruch' : 'Ruch rywala'} · ${Math.floor(lastOpp.idx / 2) + 1}.${lastOpp.m.color === 'b' ? '..' : ''}</div>
       <div class="lm-san">${esc(fmtSan(lastOpp.m.san))}</div>
       <div class="lm-desc">${esc(describeMove(lastOpp.m))}</div>
       <button class="link small" data-action="repeat">Powtórz na głos</button>`
    : `<div class="lm-label">Ruch rywala</div>
       <div class="lm-san dim">—</div>
       <div class="lm-desc">${G.myColor === 'white' ? 'Zaczynasz białymi.' : 'Rywal gra białymi — czekaj na pierwszy ruch.'}</div>`;

  let status;
  if (over) status = '';
  else if (spec) status = `<div class="status">Podgląd trenera · ruch ${G.chess?.turn() === 'w' ? 'białych' : 'czarnych'}</div>`;
  else if (myTurn(G)) status = `<div class="status on">Twój ruch</div>`;
  else status = `<div class="status">Ruch rywala — czekaj</div>`;

  const oppDraw = !spec && G.state && !over && (G.myColor === 'white' ? G.state.bdraw : G.state.wdraw);
  const myDraw = !spec && G.state && !over && (G.myColor === 'white' ? G.state.wdraw : G.state.bdraw);
  const notices = [];
  if (!G.conn) notices.push(`<div class="notice">Brak połączenia — łączę ponownie…</div>`);
  if (oppDraw) notices.push(`<div class="notice">Rywal proponuje remis. <span class="row-actions"><button class="btn small primary" data-action="draw-yes">Przyjmij</button><button class="btn small" data-action="draw-no">Odrzuć</button></span></div>`);
  if (myDraw) notices.push(`<div class="notice muted">Zaproponowałeś remis.</div>`);
  const canTakeback = !spec && !!S.provider?.takeback;
  const oppTb = canTakeback && G.state && !over && (G.myColor === 'white' ? G.state.btakeback : G.state.wtakeback);
  const myTb = canTakeback && G.state && !over && (G.myColor === 'white' ? G.state.wtakeback : G.state.btakeback);
  if (oppTb) notices.push(`<div class="notice">Rywal prosi o cofnięcie swojego ostatniego ruchu. <span class="row-actions"><button class="btn small primary" data-action="takeback-yes">Zgódź się</button><button class="btn small" data-action="takeback-no">Odmów</button></span></div>`);
  if (myTb) notices.push(`<div class="notice muted">Poprosiłeś o cofnięcie ruchu — czekam na zgodę rywala. <button class="btn small" data-action="takeback-cancel">Wycofaj prośbę</button></div>`);
  if (G.opponentGone && !over && !spec) {
    // wyraźny pasek z odliczaniem na żywo (updateClocks); przyciski aktywne po odliczaniu
    const left = goneLeft(G);
    notices.push(`<div class="gone-bar" role="alert">
      <div class="gone-title">Rywal opuścił partię</div>
      <div class="gone-sub" id="gone-sub">${left > 0 ? `Ogłosisz wygraną albo remis za <b id="gone-count">${fmtCountdown(left)}</b>, jeśli nie wróci.` : 'Możesz ogłosić wygraną albo remis.'}</div>
      <div class="row-actions"><button class="btn small primary" data-action="claim-win" ${left > 0 ? 'disabled' : ''}>Ogłoś wygraną</button>
        <button class="btn small" data-action="claim-draw" ${left > 0 ? 'disabled' : ''}>Ogłoś remis</button></div>
    </div>`);
  }

  const myMoves = G.history.filter((m) => m.color === G.myColor[0]).length;
  const actions = over || spec ? '' : `
    <div class="g-actions">
      ${canTakeback && myMoves > 0 && !myTb && (G.state?.takebackLeft?.[G.myColor] ?? 1) > 0 ? `<button class="btn small" data-action="takeback-ask">Cofnij mój ruch</button>` : ''}
      ${myDraw ? '' : `<button class="btn small" data-action="offer-draw" ${G.history.length < 2 ? 'disabled' : ''}>Zaproponuj remis</button>`}
      ${myMoves === 0 ? `<button class="btn small" data-action="abort">Przerwij</button>` : `<button class="btn small danger" data-action="resign">Poddaj</button>`}
    </div>`;

  return `
  <main class="game">
    <header class="g-top">
      <button class="btn small" data-action="back">← Partie</button>
      <div class="g-meta">${esc(meta)}</div>
      <button class="icon-btn" data-action="game-menu" aria-label="Menu">⋯</button>
    </header>

    <div class="player">
      <span class="pname">${esc(playerLabel(opp))} <span class="muted">· ${G.myColor === 'white' ? 'czarne' : 'białe'}</span></span>
      <span class="clock" id="clock-opp"></span>
    </div>

    <section class="lastmove">${lastBlock}</section>

    ${notices.join('')}

    <div class="player me">
      <span class="pname">${spec ? esc(playerLabel(me)) : 'Ty'} <span class="muted">· ${G.myColor === 'white' ? 'białe' : 'czarne'}</span></span>
      <span class="clock" id="clock-me"></span>
    </div>
    ${status}

    <section id="entry">${over ? viewResult(G) : spec ? `<div class="spectate">${boardHtml()}</div>` : viewEntry()}</section>

    ${actions}

    ${viewHistory(G)}
  </main>`;
}

function viewEntry() {
  const G = S.game;
  const enabled = myTurn(G) && !S.sending;
  return sanEntry() ? viewEntrySan(G, enabled) : viewEntrySquares(G, enabled);
}

function viewEntrySan(G, enabled) {
  const hints = hintsOn(G);
  const r = hints ? sanMatch(S.san) : { state: S.san ? 'typed' : 'empty' };
  let line;
  let cls = 'entry-msg';
  if (S.entryMsg) {
    line = esc(S.entryMsg);
    if (/Nie udało|odrzucił|nie Twój|niedozwolony|Niepoprawny|niejednoznaczny|Dopisz/i.test(S.entryMsg)) cls += ' err';
  } else if (r.state === 'typed') {
    line = '<span class="muted small">Gotowe? Naciśnij „Wyślij ruch”.</span>';
  } else if (r.state === 'ok') {
    line = `<span><strong>${esc(fmtSan(r.move.san))}</strong> — ${esc(describeMove(r.move))}</span>`;
  } else if (r.state === 'partial') {
    line = `<span class="muted small">Pasuje: ${esc(r.hints.slice(0, 10).map(fmtSan).join(', '))}${r.hints.length > 10 ? '…' : ''}</span>`;
  } else if (r.state === 'ambiguous' || r.state === 'promo') {
    line = esc(r.msg); cls += ' warn';
  } else if (r.state === 'bad') {
    line = esc(r.msg); cls += ' err';
  } else {
    line = `<span class="muted small">${G.history.length < 2 && myTurn(G)
      ? 'Zagraj na szachownicy i zapisz ruch, np. e4 albo Nf3.'
      : 'Figura + pole (Nf3), pion: pole (e4) lub bicie (exd5). Roszada: O-O.'}</span>`;
  }
  const on = enabled ? '' : 'disabled';
  const key = (k, label, extra = '') => `<button class="key ${extra}" data-action="san" data-k="${k}" ${on}>${label}</button>`;
  const pieceKeys = SAN_PIECES.map(([en, name, pl]) => key(en, `${englishLetters() ? en : pl}<span class="key-sub">${name}</span>`, 'piece')).join('');
  const fileKeys = FILES.map((f) => key(f, f)).join('');
  const rankKeys = RANKS.map((n) => key(n, n)).join('');
  const extra = [['x', 'x<span class="key-sub">bicie</span>'], ['=', '=<span class="key-sub">promocja</span>'], ['O-O', 'O-O<span class="key-sub">krótka</span>'], ['O-O-O', 'O-O-O<span class="key-sub">długa</span>']]
    .map(([k, l]) => key(k, l, 'piece')).join('');
  return `
    <div class="san-box ${S.san ? '' : 'empty'}" aria-live="polite">${S.san ? esc(fmtSan(S.san)) : 'np. e4, Nf3, exd5, O-O'}</div>
    <div class="${cls}" aria-live="polite">${line}</div>
    <div class="keys keys5">${pieceKeys}</div>
    <div class="keys">${fileKeys}</div>
    <div class="keys">${rankKeys}</div>
    <div class="keys keys4">${extra}</div>
    <div class="entry-actions">
      <button class="btn" data-action="backspace" ${S.san.length && !S.sending ? '' : 'disabled'}>⌫ Cofnij</button>
      <button class="btn primary" data-action="send" ${enabled && (hints ? r.state === 'ok' : S.san.length > 0) ? '' : 'disabled'}>Wyślij ruch</button>
    </div>
    <div class="entry-mode"><button class="link small" data-action="entry-mode">Wpisujesz notacją · przełącz na „skąd → dokąd”</button>${hints ? ' · <span class="muted small">tryb nauki</span>' : ''}</div>`;
}

function viewEntrySquares(G, enabled) {
  const slots = [0, 1, 2, 3].map((i) => {
    const v = S.input[i];
    const cur = enabled && !S.promo && i === S.input.length;
    return `<span class="slot ${v ? 'filled' : ''} ${cur ? 'cur' : ''}">${v || ''}</span>${i === 1 ? '<span class="arrow">→</span>' : ''}`;
  }).join('');
  const kind = nextSlotKind();
  const keyOn = (k) => enabled && !S.promo && S.input.length < 4 && kind === k;
  const fileKeys = FILES.map((f) => `<button class="key" data-action="key" data-k="${f}" ${keyOn('file') ? '' : 'disabled'}>${f}</button>`).join('');
  const rankKeys = RANKS.map((r) => `<button class="key" data-action="key" data-k="${r}" ${keyOn('rank') ? '' : 'disabled'}>${r}</button>`).join('');
  const promo = S.promo ? `
    <div class="promo">
      <div class="small">Promocja piona na:</div>
      <div class="chips">${PROMO_PIECES.map((p) => `<button class="chip big" data-action="promo" data-id="${p.key}">${p.label} <span class="muted small">${p.name}</span></button>`).join('')}</div>
    </div>` : '';
  const msgClass = /niedozwolony|nie ma|Nie udało|odrzucił|nie Twój|Niepoprawny/i.test(S.entryMsg) ? 'entry-msg err' : 'entry-msg';
  const hint = G.history.length < 2 && myTurn(G) && !S.entryMsg
    ? 'Zagraj na szachownicy i wpisz ruch: pole startowe, potem docelowe (np. e2 e4).'
    : 'Roszada: wpisz ruch króla, np. e1 g1.';
  return `
    <div class="slots" aria-live="polite">${slots}</div>
    <div class="${msgClass}" aria-live="polite">${esc(S.entryMsg) || `<span class="muted small">${hint}</span>`}</div>
    ${promo}
    <div class="keys">${fileKeys}</div>
    <div class="keys">${rankKeys}</div>
    <div class="entry-actions">
      <button class="btn" data-action="backspace" ${S.input.length && !S.sending ? '' : 'disabled'}>⌫ Cofnij</button>
      <button class="btn primary" data-action="send" ${enabled && S.input.length === 4 && !S.promo ? '' : 'disabled'}>Wyślij ruch</button>
    </div>
    <div class="entry-mode"><button class="link small" data-action="entry-mode">Wpisujesz „skąd → dokąd” · przełącz na notację (np. Nf3)</button></div>`;
}

function renderEntry() {
  const el = document.getElementById('entry');
  if (!el || !S.game || gameOver(S.game)) { render(); return; }
  el.innerHTML = viewEntry();
}

// Propozycja rewanżu od rywala tej partii (przychodzące wyzwanie od niego).
function rematchOffer() {
  const G = S.game;
  if (!G?.full || G.spectator || !gameOver(G)) return null;
  const opp = G.myColor === 'white' ? G.full.black : G.full.white;
  for (const c of S.challenges.values()) {
    if ((c.fromId && opp.id && c.fromId === opp.id) || (!c.fromId && c.from && c.from.toLowerCase() === String(opp.name).toLowerCase())) return c;
  }
  return null;
}
const UNRATED_PL = {
  short: 'poddanie lub remis przed 5. ruchem nie zmienia rankingu',
  limit: 'z tym samym rywalem liczą się najwyżej 3 partie rankingowe dziennie',
  account: 'ranking wymaga konta u obojga graczy',
  aborted: 'partia przerwana',
};
function viewRatingResult(G) {
  const rr = G.ratingResult;
  if (!rr || !G.full?.rated || G.spectator) return '';
  if (!rr.counted) return `<div class="muted small">Ranking bez zmian: ${esc(UNRATED_PL[rr.reason] || 'partia się nie liczyła')}.</div>`;
  const d = G.myColor === 'white' ? rr.diffW : rr.diffB;
  const now = S.provider?.me?.ratings?.[G.full.speed === 'classical' ? 'classical' : 'rapid']?.rating;
  return `<div class="rating-change">Ranking: <b>${d > 0 ? '+' : ''}${d ?? 0}</b>${now ? ` → ${now}` : ''}</div>`;
}

function viewResult(G) {
  const r = resultText(G);
  const url = S.provider.gameUrl?.(G.id);
  const offer = rematchOffer();
  return `
    <div class="result">
      <div class="result-title">${esc(r.title)}</div>
      ${r.sub ? `<div class="muted">${esc(r.sub)}</div>` : ''}
      ${viewRatingResult(G)}
      ${offer ? `<div class="notice rematch-note">${esc(offer.from)} proponuje rewanż</div>` : ''}
      <div class="stack">
        ${G.spectator ? '' : `<button class="btn primary ${offer ? 'pulse' : ''}" data-action="rematch">${offer ? 'Rewanż — odpowiedz' : 'Rewanż'}</button>`}
        <button class="btn ${G.spectator ? 'primary' : ''}" data-action="back">${G.spectator ? 'Wróć do panelu trenera' : 'Wróć do listy partii'}</button>
        ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Analiza partii na Lichess</a>` : ''}
        ${!url && S.provider.gamePgn ? `<button class="btn" data-action="game-analysis" data-id="${esc(G.id)}">Analiza partii na Lichess</button>
          <button class="link small" data-action="game-pgn" data-id="${esc(G.id)}">Pobierz zapis partii (PGN)</button>` : ''}
      </div>
    </div>`;
}

// --- rewanż, zapis partii, analiza ----------------------------------------------
// Rewanż: to samo tempo i rodzaj partii, kolory zamienione.
async function rematch() {
  unlockMedia();
  const G = S.game;
  if (!G?.full) return;
  // rywal już zaproponował rewanż — potwierdzenie „Przyjąć?”
  const offer = rematchOffer();
  if (offer) {
    const color = offer.color === 'white' ? 'białymi' : offer.color === 'black' ? 'czarnymi' : 'losowym kolorem';
    S.modal = {
      kind: 'confirm', title: 'Przyjąć rewanż?',
      text: `${offer.from} proponuje rewanż: ${offer.label}${offer.rated ? ', rankingowa' : ', towarzyska'}. Grasz ${color}.`,
      okLabel: 'Tak, gramy', cancelLabel: 'Nie',
      onOk: async () => { closeGame(); S.view = 'lobby'; await acceptChallenge(offer.id); },
      onCancel: async () => { await declineChallenge(offer.id); },
    };
    render();
    return;
  }
  const f = G.full;
  const opp = G.myColor === 'white' ? f.black : f.white;
  const color = G.myColor === 'white' ? 'black' : 'white';
  const opts = f.clock ? { time: f.clock.initial / 60000, increment: f.clock.increment / 1000 } : { days: f.daysPerTurn };
  opts.rated = !!f.rated;
  opts.color = color;
  closeGame();
  S.view = 'lobby';
  S.waiting = { text: 'Wysyłanie propozycji rewanżu…', kind: 'pending' };
  render();
  try {
    if (opp.ai) {
      const { gameId } = await S.provider.challengeAI({ ...opts, level: opp.ai });
      S.waiting = null;
      openGame(gameId, color);
      return;
    }
    const h = await S.provider.challenge(opp.id || opp.name, opts);
    if (h.matched) { if (S.waiting?.kind === 'pending') S.waiting = null; render(); return; } // obaj kliknęli „Rewanż”
    if (h.correspondence) {
      S.waiting = null; toast(`Rewanż wysłany do ${opp.name}. Partia pojawi się na liście po przyjęciu.`, 6000); render(); return;
    }
    waitFor(h, `Czekam, aż ${opp.name} przyjmie rewanż`);
  } catch (e) {
    S.waiting = null; toast(e.message || 'Nie udało się wysłać rewanżu.'); render();
  }
}

function downloadText(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function downloadGamePgn(id) {
  try {
    const p = await S.provider.gamePgn(id);
    downloadText(`partia-${id}.pgn`, p.pgn);
  } catch (e) { toast(e.message); }
}

// Analiza w Lichess: ruchy w adresie (lichess.org/analysis/pgn/e4_e5_Nf3), bez logowania.
async function openAnalysis(id) {
  const w = window.open('about:blank', '_blank'); // otwarte od razu po kliknięciu — nie zablokuje się
  try {
    const p = await S.provider.gamePgn(id);
    const url = 'https://lichess.org/analysis/pgn/' + p.san.map(encodeURIComponent).join('_');
    if (w) { w.opener = null; w.location.href = url; } else location.href = url;
  } catch (e) { if (w) w.close(); toast(e.message); }
}

// --- panel trenera (założyciel lub admin klubu) -----------------------------------------
function isCoach() { return !!S.provider?.features?.rooms && !S.provider.isPublic && ['owner', 'admin'].includes(S.provider.me?.role); }

async function loadCoach() {
  S.coach = { ...(S.coach || {}), loading: true };
  render();
  try {
    const d = await S.provider.coachPanel();
    S.coach = { data: d, loading: false };
    if (!S.roomHistory) S.roomHistory = await S.provider.history();
  } catch (e) { S.coach = { loading: false, error: e.message }; }
  if (S.view === 'coach') render();
}

function viewCoach() {
  const c = S.coach || {};
  const d = c.data;
  const ago = (t) => (t ? new Date(t).toLocaleDateString('pl-PL') : '—');
  const ongoing = d?.ongoing?.length
    ? d.ongoing.map((g) => `
      <button class="row" data-action="coach-watch" data-id="${esc(g.id)}">
        <span class="row-main">${esc(g.white)} – ${esc(g.black)}</span>
        <span class="row-sub">${esc(SPEED_PL[g.speed] || g.speed)} ${esc(g.label)} · ${g.plies} półruchów${g.rated ? '' : ' · towarzyska'}</span>
        <span class="pill">Podgląd</span>
      </button>`).join('')
    : `<p class="muted small">Nikt teraz nie gra.</p>`;
  const myRole = S.provider.me?.role;
  const meId = S.user?.id;
  const ROLE_PL = { owner: 'założyciel', admin: 'admin' };
  // założyciel: mianuje adminów i usuwa; admin: usuwa zwykłych członków
  const manage = (m) => {
    if (m.id === meId || m.role === 'owner') return '';
    const b = [];
    if (myRole === 'owner') b.push(`<button class="link small" data-action="member-role" data-id="${esc(m.id)}" data-role="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'odbierz admina' : 'zrób adminem'}</button>`);
    if (myRole === 'owner' || m.role !== 'admin') b.push(`<button class="link small danger-text" data-action="member-remove" data-id="${esc(m.id)}" data-nick="${esc(m.nick)}">usuń</button>`);
    return b.join(' · ');
  };
  const players = d ? `
    <div class="scroll"><table class="coach-table">
      <tr><th>Gracz</th><th>Partie</th><th>W</th><th>R</th><th>P</th><th>Ostatnia</th><th></th></tr>
      ${d.members.map((m) => `<tr><td><span class="dot ${m.online ? 'on' : 'off'}"></span>${esc(m.nick)}${ROLE_PL[m.role] ? ` <span class="muted small">(${ROLE_PL[m.role]})</span>` : ''}${m.account ? '' : ' <span class="muted small" title="bez konta — tylko partie towarzyskie">·bez konta</span>'}</td>
        <td>${m.games}</td><td>${m.wins}</td><td>${m.draws}</td><td>${m.losses}</td><td>${ago(m.last)}</td><td class="nowrap">${manage(m)}</td></tr>`).join('')}
    </table></div>
    <p class="muted small">W — wygrane, R — remisy, P — przegrane. Liczą się zakończone partie (rankingowe i towarzyskie).
      ${myRole === 'owner' ? 'Admin może przeglądać partie i usuwać członków.' : ''} Usunięta osoba z kontem nie wróci do klubu z tego konta.</p>` : '';
  const hist = (S.roomHistory || []).filter((g) => g.status !== 'aborted' && g.status !== 'noStart');
  const games = hist.length ? `<ul class="hist-list">${hist.map((g) => `
      <li>
        <span class="hist-players">${esc(g.white)} – ${esc(g.black)}</span>
        <span class="hist-res">${RESULT_PL[g.winner] || '½–½'}</span>
        <span class="muted small">${esc(g.label)} · ${g.plies} półruchów · ${new Date(g.endedAt).toLocaleDateString('pl-PL')}
          · <button class="link small" data-action="game-analysis" data-id="${esc(g.id)}">analiza</button>
          · <button class="link small" data-action="game-pgn" data-id="${esc(g.id)}">PGN</button></span>
      </li>`).join('')}</ul>` : `<p class="muted small">Jeszcze nie rozegrano żadnej partii.</p>`;
  return `
  <main class="lobby">
    <header class="g-top"><button class="btn small" data-action="coach-close">← Klub</button>
      <div class="g-meta">Panel trenera · ${esc(S.provider.roomName)}</div>
      <button class="icon-btn" data-action="coach-refresh" aria-label="Odśwież">↻</button></header>
    ${c.error ? `<p class="error">${esc(c.error)}</p>` : ''}
    ${c.loading && !d ? '<p class="muted">Wczytywanie…</p>' : ''}
    <section class="card"><h2>Trwające partie</h2>${ongoing}
      <p class="muted small">Podgląd na żywo: ruchy, zegary i pozycja. Gracze nie widzą, że oglądasz.</p></section>
    <section class="card"><h2>Gracze</h2>${players}</section>
    <section class="card"><h2>Rozegrane partie</h2>${games}
      ${hist.length ? `<button class="btn small" data-action="room-pgn">Pobierz wszystkie partie (PGN)</button>` : ''}</section>
  </main>`;
}

function viewHistory(G) {
  if (!G.history.length) return '';
  const rows = [];
  for (let i = 0; i < G.history.length; i += 2) {
    const w = G.history[i];
    const b = G.history[i + 1];
    rows.push(`<li><span class="hn">${i / 2 + 1}.</span><span class="hm">${esc(fmtSan(w.san))}</span><span class="hm">${b ? esc(fmtSan(b.san)) : ''}</span></li>`);
  }
  return `
    <details class="history" ${S.historyOpen ? 'open' : ''} data-action="history-toggle">
      <summary>Zapis partii (${G.history.length} pół­ruchów)</summary>
      <ol class="hlist">${rows.join('')}</ol>
    </details>`;
}

function viewWaiting() {
  if (!S.waiting) return '';
  return `
  <div class="overlay">
    <div class="dialog">
      <div class="spinner" aria-hidden="true"></div>
      <p>${esc(S.waiting.text)}</p>
      ${S.waiting.cancel ? `<button class="btn" data-action="cancel-wait">Anuluj</button>` : ''}
    </div>
  </div>`;
}

const PIECE_CHAR = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟' };

function viewModal() {
  const m = S.modal;
  if (!m) return '';
  let body = '';
  if (m.kind === 'confirm') {
    body = `
      <h2>${esc(m.title)}</h2>
      ${m.text ? `<p>${esc(m.text)}</p>` : ''}
      <div class="row-actions end">
        <button class="btn" data-action="modal-cancel">${esc(m.cancelLabel || 'Anuluj')}</button>
        <button class="btn ${m.danger ? 'danger' : 'primary'}" data-action="modal-ok">${esc(m.okLabel || 'OK')}</button>
      </div>`;
  } else if (m.kind === 'prompt') {
    // proste pole tekstowe (np. nowe hasło klubu)
    body = `
      <h2>${esc(m.title)}</h2>
      ${m.text ? `<p class="small">${esc(m.text)}</p>` : ''}
      <form data-form="prompt" autocomplete="off">
        <label class="field">${esc(m.label || '')}<input id="prompt-input" type="${m.type || 'text'}" autocomplete="${m.autocomplete || 'off'}" value="${esc(m.value || '')}"></label>
        <div class="row-actions end">
          <button type="button" class="btn" data-action="modal-close">Anuluj</button>
          <button type="submit" class="btn primary">${esc(m.okLabel || 'Zapisz')}</button>
        </div>
      </form>`;
  } else if (m.kind === 'settings') {
    const t = (key, label, sub) => `
      <label class="toggle"><input type="checkbox" data-action="setting" data-key="${key}" ${S.settings[key] ? 'checked' : ''}>
        <span>${label}${sub ? `<br><span class="muted small">${sub}</span>` : ''}</span></label>`;
    body = `
      <h2>Ustawienia</h2>
      ${t('speech', 'Czytaj ruch rywala na głos', 'Po polsku, jeśli urządzenie ma polski głos.')}
      ${t('sound', 'Krótki dźwięk przy ruchu rywala')}
      ${t('vibrate', 'Wibracja przy ruchu rywala', 'Działa na Androidzie.')}
      ${t('sanEntry', 'Wpisuję ruch notacją (np. Nf3, exd5, O-O)', 'Oficjalny zapis turniejowy. Wyłączone = pole startowe i docelowe (e2 e4).')}
      ${t('englishNotation', 'Angielskie litery figur: K Q R B N', 'Jak na turniejach i w Lichess. Wyłączone = polskie: K H W G S (ruch rywala, zapis partii, przyciski).')}
      ${t('autoSend', 'Wysyłaj ruch od razu po wpisaniu', 'Bez przycisku „Wyślij”. Szybciej, ale łatwiej o pomyłkę.')}
      ${t('emergencyBoard', 'Awaryjny podgląd pozycji w menu partii', 'Na wypadek pomyłki przy przestawianiu bierek.')}
      ${t('learnMode', 'Tryb nauki: podpowiedzi przy wpisywaniu ruchu', 'Tylko w partiach towarzyskich: pokazuje pasujące ruchy i opis. W rankingowych podpowiedzi nie ma nigdy.')}
      <div class="row-actions end"><button class="btn primary" data-action="modal-close">Gotowe</button></div>`;
  } else if (m.kind === 'game-menu') {
    body = `
      <h2>Partia</h2>
      <div class="stack">
        ${S.settings.emergencyBoard ? `<button class="btn" data-action="show-board">Awaryjny podgląd pozycji</button>` : ''}
        <button class="btn" data-action="settings">Ustawienia</button>
        <button class="btn" data-action="modal-close">Zamknij</button>
      </div>`;
  } else if (m.kind === 'board') {
    body = `<h2>Pozycja w partii</h2><p class="muted small">Sprawdź i popraw ustawienie bierek na swojej szachownicy.</p>${boardHtml()}
      <div class="row-actions end"><button class="btn primary" data-action="modal-close">Zamknij</button></div>`;
  } else if (m.kind === 'token') {
    const url = S.provider?.tokenCreateUrl?.() || new LichessProvider().tokenCreateUrl();
    body = `
      <h2>Logowanie tokenem</h2>
      <p class="small">Przydaje się, gdy zwykłe logowanie nie wraca do aplikacji (np. na iPhonie po dodaniu do ekranu głównego).</p>
      <ol class="small">
        <li><a href="${esc(url)}" target="_blank" rel="noopener">Utwórz token na Lichess</a> (uprawnienie „Play games with the board API” jest już zaznaczone).</li>
        <li>Skopiuj token i wklej go poniżej.</li>
      </ol>
      <label class="field">Token
        <input id="token-input" type="password" autocomplete="off" spellcheck="false" placeholder="lip_…">
      </label>
      <div class="row-actions end">
        <button class="btn" data-action="modal-close">Anuluj</button>
        <button class="btn primary" data-action="token-save">Zaloguj</button>
      </div>`;
  } else if (m.kind === 'room') {
    const p = S.provider;
    const link = p.inviteLink();
    const t = S.transfer;
    const me = p.me || {};
    const room = p.room || {};
    const acct = savedAccount();
    const owner = me.role === 'owner';
    const accountPart = p.isPublic
      ? `<p class="small">Konto: <strong>${esc(S.user?.name || '')}</strong>${me.hasPassword ? ' · zabezpieczone hasłem' : ' · <span class="warn">bez hasła</span>'}${me.email ? `<br><span class="muted">E-mail: ${esc(me.email)}</span>` : ''}</p>
         ${me.hasPassword ? '' : `<p class="note small">Bez hasła konto i ranking są tylko na tym urządzeniu. Ustaw hasło, żeby logować się na każdym urządzeniu.</p>`}
         <div class="row-actions"><button class="btn small ${me.hasPassword ? '' : 'primary'}" data-action="secure-open">${me.hasPassword ? 'Zmień hasło lub e-mail' : 'Ustaw hasło'}</button></div>`
      : `<p class="small">Kod klubu — podaj go osobom, z którymi chcesz grać:</p>
      <div class="club-code" id="club-code-show">${esc(p.roomCode)}</div>
      <input class="link-box" id="invite-link" type="text" readonly value="${esc(link || '')}" aria-label="Link do klubu">
      <div class="row-actions">
        <button class="btn small primary" data-action="share-invite">Udostępnij link</button>
        <button class="btn small" data-action="copy-code">Kopiuj kod</button>
      </div>
      <p class="muted small">Kod i link otwierają klub każdemu, kto je ma — wysyłaj tylko swoim.${room.hasPassword ? ' Do dołączenia potrzebne jest też hasło klubu.' : ''}</p>
      ${owner ? `<h3>Dostęp do klubu</h3>
        <div class="row-actions">
          <button class="btn small" data-action="club-recode">Zmień kod</button>
          <button class="btn small" data-action="club-password">${room.hasPassword ? 'Zmień lub usuń hasło klubu' : 'Ustaw hasło klubu'}</button>
        </div>
        <p class="muted small">Po zmianie kodu stary kod i link przestają działać; obecni członkowie zostają.</p>` : ''}
      ${acct && !me.linked ? `<h3>Konto</h3><p class="small">Zapisz ten klub na koncie ${esc(acct.nick)} — wrócisz do niego po zalogowaniu na innym urządzeniu, a partie rankingowe policzą się do Twojego rankingu.</p>
        <div class="row-actions"><button class="btn small" data-action="link-account">Zapisz klub na koncie</button></div>` : ''}`;
    const forget = p.isPublic
      ? (me.hasPassword
        ? `<button class="btn small" data-action="account-logout">Wyloguj z tego urządzenia</button>`
        : `<button class="btn small danger" data-action="room-forget">Usuń konto z tego urządzenia</button>`)
      : `${owner ? '' : `<button class="btn small danger" data-action="club-leave">Opuść klub</button>`}
         <button class="btn small" data-action="room-forget">Usuń z tego urządzenia</button>`;
    body = `
      <h2>${p.isPublic ? 'Twoje konto' : `Klub „${esc(p.roomName)}”`}</h2>
      ${accountPart}
      <h3>Inne urządzenie</h3>
      <p class="small">${p.isPublic && me.hasPassword ? 'Na innym urządzeniu po prostu zaloguj się nickiem i hasłem. Możesz też użyć' : 'Chcesz grać na drugim telefonie lub komputerze pod tym samym nickiem? Użyj tam'} jednorazowego linku albo 6-cyfrowego kodu (ważne 10 minut).</p>
      ${t ? `<div class="club-code">${esc(String(t.code6 || '').replace(/(\d{3})(\d{3})/, '$1 $2'))}</div>
        <p class="muted small">Na drugim urządzeniu: ekran startowy → „Mam kod przeniesienia”. Albo otwórz tam link:</p>
        <input class="link-box" type="text" readonly value="${esc(t.url)}">
        <div class="row-actions"><button class="btn small" data-action="share-transfer">Udostępnij link przeniesienia</button></div>
        <p class="muted small">Nie podawaj kodu ani linku nikomu innemu — kto ich użyje, gra jako Ty.</p>`
    : `<div class="row-actions"><button class="btn small" data-action="make-transfer">Utwórz kod przeniesienia</button></div>`}
      <div class="row-actions end">
        ${forget}
        <button class="btn primary" data-action="modal-close">Gotowe</button>
      </div>`;
  } else if (m.kind === 'secure') {
    const me = S.provider?.me || {};
    body = `
      <h2>${me.hasPassword ? 'Zmień hasło lub e-mail' : 'Zabezpiecz konto'}</h2>
      <p class="small">Logujesz się nickiem <strong>${esc(S.user?.name || '')}</strong> i hasłem. Ranking zostaje.</p>
      <form data-form="secure" method="post" action="#">
      <input type="text" name="username" autocomplete="username" value="${esc(S.user?.name || '')}" hidden>
      ${me.hasPassword ? `<label class="field">Obecne hasło <span class="muted">(tylko przy zmianie hasła)</span><input id="sec-old" type="password" autocomplete="current-password"></label>` : ''}
      <label class="field">${me.hasPassword ? 'Nowe hasło (puste = bez zmiany)' : 'Hasło (min. 8 znaków)'}<input id="sec-pass" name="password" type="password" autocomplete="new-password"></label>
      <p class="muted small">Użyj hasła, którego nie używasz nigdzie indziej. ${me.hasPassword ? 'Po zmianie hasła inne urządzenia zostaną wylogowane.' : ''}</p>
      <label class="field">E-mail <span class="muted">(nieobowiązkowy — do odzyskania hasła)</span>
        <input id="sec-email" type="email" autocomplete="email" inputmode="email" value="${esc(me.email || '')}" placeholder="adres@e-mail.pl"></label>
      <div class="row-actions end">
        <button type="button" class="btn" data-action="modal-close">Anuluj</button>
        <button type="submit" class="btn primary">Zapisz</button>
      </div>
      </form>`;
  }
  return `<div class="overlay" data-action="overlay"><div class="dialog wide" role="dialog" aria-modal="true">${body}</div></div>`;
}

function boardHtml() {
  const G = S.game;
  if (!G?.chess) return '';
  const board = G.chess.board(); // [rank8..rank1][a..h]
  const flip = G.myColor === 'black';
  const ranks = flip ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
  const files = flip ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
  let html = '<div class="mini-board">';
  for (const r of ranks) {
    html += `<div class="mb-label">${8 - r}</div>`;
    for (const f of files) {
      const sq = board[r][f];
      const dark = (r + f) % 2 === 1;
      html += `<div class="mb-sq ${dark ? 'd' : 'l'}">${sq ? PIECE_CHAR[sq.color + sq.type] : ''}</div>`;
    }
  }
  html += '<div></div>' + files.map((f) => `<div class="mb-label">${FILES[f]}</div>`).join('') + '</div>';
  return html;
}

// --- zegary ---------------------------------------------------------------
function liveTimes(G) {
  if (!G?.state || !G.full) return null;
  let { wtime, btime } = G.state;
  if (wtime == null || btime == null) return null;
  if (!gameOver(G) && G.history.length >= 2) {
    const el = performance.now() - G.clockAt;
    if (G.chess.turn() === 'w') wtime -= el; else btime -= el;
  }
  return { wtime, btime };
}
function updateClocks() {
  const G = S.game;
  if (S.view !== 'game' || !G?.full) return;
  const t = liveTimes(G);
  const me = document.getElementById('clock-me');
  const opp = document.getElementById('clock-opp');
  if (!t || !me || !opp) return;
  const mine = G.myColor === 'white' ? t.wtime : t.btime;
  const theirs = G.myColor === 'white' ? t.btime : t.wtime;
  me.textContent = formatMs(mine);
  opp.textContent = formatMs(theirs);
  const turn = G.chess.turn();
  const running = !gameOver(G);
  me.classList.toggle('running', running && turn === G.myColor[0]);
  opp.classList.toggle('running', running && turn !== G.myColor[0]);
  me.classList.toggle('low', G.full.clock && mine < 30000);
  // odliczanie po wyjściu rywala; po zerze odśwież ekran (włącza przyciski)
  if (G.opponentGone) {
    const left = goneLeft(G);
    const c = document.getElementById('gone-count');
    if (c) { if (left > 0) c.textContent = fmtCountdown(left); else render(); }
  }
}
function goneLeft(G) { return G.opponentGone ? Math.max(0, Math.ceil((G.opponentGone.deadline - Date.now()) / 1000)) : 0; }
function fmtCountdown(s) { return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`; }
setInterval(updateClocks, 200);

// ---------------------------------------------------------------------------
// Obsługa kliknięć i klawiatury
// ---------------------------------------------------------------------------
function saveForm() { lsSet('ps_form', JSON.stringify({ ...S.form, friend: S.form.friend })); }

function confirmModal(opts) { S.modal = { kind: 'confirm', ...opts }; render(); }

app.addEventListener('click', async (e) => {
  unlockMedia();
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  if (a === 'overlay') { if (e.target === el) { S.modal = null; render(); } return; }
  if (a === 'history-toggle' || a === 'room-history' || a === 'rated' || a === 'setting') return; // obsługiwane przez 'change'/'toggle'
  switch (a) {
    case 'login':
      try { await new LichessProvider().login(); } catch (err) { S.startError = 'Nie udało się rozpocząć logowania: ' + err.message; render(); }
      break;
    case 'token-login': S.modal = { kind: 'token' }; render(); break;
    case 'token-save': {
      const v = (document.getElementById('token-input')?.value || '').trim();
      if (!/^[A-Za-z0-9_]{10,}$/.test(v)) { toast('To nie wygląda na token Lichess.'); break; }
      const p = new LichessProvider();
      p.setToken(v);
      S.modal = null;
      await enterWith(p);
      break;
    }
    case 'demo': S.startError = ''; await enterWith(new DemoProvider()); break;
    case 'to-menu': goMenu(); break;
    case 'lichess-resume': S.startError = ''; await enterWith(new LichessProvider()); break;
    case 'lichess-logout':
      confirmModal({
        title: 'Wylogować z Lichess?', text: 'Aplikacja straci dostęp do Twojego konta Lichess na tym urządzeniu.', okLabel: 'Wyloguj',
        onOk: async () => { await new LichessProvider().logout(); render(); },
      });
      break;
    case 'logout':
      confirmModal({ title: 'Wylogować?', text: S.provider?.isDemo ? 'Zakończysz tryb demo.' : 'Aplikacja straci dostęp do Twojego konta Lichess na tym urządzeniu.', okLabel: 'Wyloguj', onOk: logout });
      break;
    // --- wariant B: pokoje ---
    case 'room-new': S.startError = ''; S.view = 'room-new'; render(); break;
    case 'to-start': S.joinRoom = null; S.view = 'start'; render(); break;
    // szybka gra = poczekalnia ogólna; bez konta najpierw rejestracja
    case 'quick-play': {
      S.startError = '';
      const acct = savedAccount();
      if (acct) await enterWith(new RoomsProvider(acct));
      else openAccount('register', 'public');
      break;
    }
    case 'open-club': await openClub(id); break;
    case 'club-join-open': S.startError = ''; await openClubJoin(''); break;
    case 'club-code-change': S.joinRoom = { code: '', checked: false, error: '' }; render(); document.getElementById('club-code')?.focus(); break;
    case 'hide-standalone': S.standaloneHint = false; render(); break;
    case 'account-login': openAccount('login', 'start'); break;
    case 'account-menu': {
      const acct = savedAccount();
      if (!acct) break;
      await enterWith(new RoomsProvider(acct));
      if (S.provider) { S.modal = { kind: 'room' }; render(); }
      break;
    }
    case 'acct-mode': S.accountForm.mode = id; S.accountForm.info = ''; render(); break;
    case 'secure-open': S.modal = { kind: 'secure' }; render(); break;
    // --- znajomi ---
    case 'friend-challenge': S.form.mode = 'member'; S.form.opponent = id; saveForm(); await startNewGame(); break;
    case 'friend-accept': await social(() => S.provider.friendAccept(id), 'Dodano do znajomych.'); break;
    case 'friend-decline': await social(() => S.provider.friendDecline(id)); break;
    case 'friend-cancel': await social(() => S.provider.friendCancel(id)); break;
    case 'friend-invite-id': await social(() => S.provider.friendInvite({ id }), 'Wysłano zaproszenie.'); break;
    case 'friend-unblock': await social(() => S.provider.unblock(id), 'Odblokowano.'); break;
    case 'friend-block': {
      const p = findPerson(id);
      confirmModal({
        title: `Zablokować ${p?.nick || 'gracza'}?`, text: 'Nie będzie mógł Cię wyzwać ani zaprosić do znajomych. Zniknie z Twoich znajomych i ostatnich rywali. Nie dowie się o blokadzie.',
        okLabel: 'Zablokuj', danger: true, onOk: () => social(() => S.provider.block(id), 'Zablokowano.'),
      });
      break;
    }
    case 'friend-more': {
      const p = findPerson(id);
      confirmModal({
        title: p?.nick || 'Znajomy', text: 'Usunąć z listy znajomych? Możesz też zablokować tę osobę.',
        okLabel: 'Usuń ze znajomych', danger: true, cancelLabel: 'Zablokuj',
        onOk: () => social(() => S.provider.friendRemove(id), 'Usunięto ze znajomych.'),
        onCancel: () => social(() => S.provider.block(id), 'Zablokowano.'),
      });
      break;
    }
    // --- zarządzanie klubem ---
    case 'copy-code':
      try { await navigator.clipboard.writeText(S.provider.roomCode); toast('Skopiowano kod.'); } catch { toast('Skopiuj kod ręcznie.'); }
      break;
    case 'club-recode':
      confirmModal({
        title: 'Zmienić kod klubu?', text: 'Stary kod i link przestaną działać. Obecni członkowie zostają w klubie.', okLabel: 'Zmień kod',
        onOk: async () => { try { const c = await S.provider.changeCode(); toast(`Nowy kod: ${c}`, 5000); S.modal = { kind: 'room' }; render(); } catch (err) { toast(err.message); } },
      });
      break;
    case 'club-password':
      S.modal = {
        kind: 'prompt', title: 'Hasło klubu', label: 'Nowe hasło (puste = bez hasła)', type: 'password', autocomplete: 'new-password',
        text: 'Hasło klubu jest dodatkowym zabezpieczeniem oprócz kodu: dołączający musi znać jedno i drugie. Obecni członkowie nie muszą go wpisywać.',
        onOk: async (v) => {
          try { const has = await S.provider.setRoomPassword(v); toast(has ? 'Ustawiono hasło klubu.' : 'Usunięto hasło klubu.'); S.modal = { kind: 'room' }; render(); } catch (err) { toast(err.message, 5000); }
        },
      };
      render();
      break;
    case 'club-leave':
      confirmModal({
        title: 'Opuścić klub?', text: 'Znikniesz z listy członków. Ranking zostaje (jest wspólny). Wrócisz, dołączając ponownie kodem klubu.',
        okLabel: 'Opuść klub', danger: true,
        onOk: async () => { try { await S.provider.leaveRoom(); toast('Opuszczono klub.'); goMenu(); } catch (err) { toast(err.message); } },
      });
      break;
    case 'member-role':
      try { await S.provider.setRole(id, el.dataset.role); await loadCoach(); } catch (err) { toast(err.message); }
      break;
    case 'member-remove':
      confirmModal({
        title: `Usunąć ${el.dataset.nick} z klubu?`, text: 'Ta osoba zostanie wylogowana z klubu. Jeśli ma konto, nie wróci z niego nawet znając kod (bez konta mogłaby dołączyć ponownie — wtedy zmień kod klubu). Jej partie zostają w historii.',
        okLabel: 'Usuń', danger: true,
        onOk: async () => { try { await S.provider.removeMember(id); toast('Usunięto z klubu.'); await loadCoach(); } catch (err) { toast(err.message); } },
      });
      break;
    case 'account-logout':
      confirmModal({
        title: 'Wylogować z tego urządzenia?', text: 'Zalogujesz się ponownie nickiem i hasłem. Ranking, znajomi i kluby zostają na koncie.',
        okLabel: 'Wyloguj', onOk: logout,
      });
      break;
    case 'link-account':
      try { await S.provider.linkAccount(); toast('Klub zapisany na koncie.'); render(); } catch (err) { toast(err.message, 5000); }
      break;
    case 'seek-accept':
      unlockMedia();
      S.waiting = { text: 'Łączę z rywalem…', kind: 'pending' }; render();
      try { await S.provider.seekAccept(id); } catch (err) { toast(err.message); }
      if (S.waiting?.kind === 'pending') { S.waiting = null; render(); }
      break;
    case 'room-menu': S.transfer = null; S.modal = { kind: 'room' }; render(); break;
    case 'share-invite': await shareLink(S.provider.inviteLink(), `Klub „${S.provider.roomName}” (kod ${S.provider.roomCode}) — ${CONFIG.APP_NAME}`); break;
    case 'make-transfer':
      try { S.transfer = await S.provider.transferLink(); render(); } catch (err) { toast(err.message); }
      break;
    case 'share-transfer': if (S.transfer) await shareLink(S.transfer.url, CONFIG.APP_NAME); break;
    case 'room-forget':
      confirmModal({
        title: S.provider?.isPublic ? 'Usunąć konto z tego urządzenia?' : 'Usunąć klub z tego urządzenia?',
        text: S.provider?.isPublic
          ? 'Konto bez hasła: ranking i partie zostaną przy nicku, ale z tego urządzenia już na niego nie wrócisz. Jeśli chcesz grać dalej na innym urządzeniu, najpierw utwórz kod przeniesienia.'
          : `Zostajesz członkiem klubu. ${S.provider?.me?.linked ? 'Klub jest zapisany na koncie — wrócisz do niego po zalogowaniu.' : 'Bez konta wrócisz tylko z innego urządzenia albo kodem przeniesienia utworzonym wcześniej.'}`,
        okLabel: 'Usuń z urządzenia', danger: true, onOk: logout,
      });
      break;
    case 'rank-speed': S.rankSpeed = id; render(); break;
    case 'opponent': S.form.opponent = id; saveForm(); render(); break;
    case 'settings': S.modal = { kind: 'settings' }; render(); break;
    case 'modal-close': S.modal = null; render(); break;
    case 'modal-cancel': { const fn = S.modal?.onCancel; S.modal = null; render(); if (fn) await fn(); break; }
    case 'modal-ok': { const fn = S.modal?.onOk; S.modal = null; render(); if (fn) await fn(); break; }
    case 'mode': S.form.mode = id; saveForm(); render(); break;
    case 'preset': S.form.preset = id; saveForm(); render(); break;
    case 'level': S.form.level = Number(id); saveForm(); render(); break;
    case 'color': S.form.color = id; saveForm(); render(); break;
    case 'start-game': await startNewGame(); break;
    case 'cancel-wait': {
      const w = S.waiting; S.waiting = null; render();
      try { w?.cancel?.(); } catch {}
      break;
    }
    case 'accept': await acceptChallenge(id); break;
    case 'decline': await declineChallenge(id); break;
    case 'open-game': openGame(id); break;
    case 'back': {
      const wasSpectator = !!S.game?.spectator;
      closeGame();
      if (wasSpectator) { S.view = 'coach'; loadCoach(); break; }
      S.view = 'lobby'; render(); refreshOngoing();
      break;
    }
    case 'rematch': await rematch(); break;
    case 'game-analysis': await openAnalysis(id); break;
    case 'game-pgn': await downloadGamePgn(id); break;
    case 'room-pgn':
      try { downloadText(`partie-${S.provider.roomCode}.pgn`, await S.provider.roomPgn()); } catch (err) { toast(err.message); }
      break;
    case 'coach-open': S.view = 'coach'; await loadCoach(); break;
    case 'coach-refresh': S.roomHistory = null; await loadCoach(); break;
    case 'coach-close': S.view = 'lobby'; render(); break;
    case 'coach-watch': openGame(id); break;
    case 'key': pressKey(el.dataset.k); break;
    case 'backspace': backspace(); break;
    case 'send': await sendMove(); break;
    case 'promo': await sendMove(id); break;
    case 'san': pressSan(el.dataset.k); break;
    case 'entry-mode':
      if (S.sending) break;
      S.settings.sanEntry = !sanEntry(); saveSettings();
      resetEntry(); S.entryMsg = '';
      toast(sanEntry() ? 'Notacja: zapisz ruch, np. e4 albo Nf3.' : 'Skąd → dokąd: wpisz pole startowe i docelowe.');
      renderEntry();
      break;
    case 'repeat': {
      const G = S.game;
      const last = [...(G?.history || [])].reverse().find((m) => m.color !== G.myColor[0]);
      if (last) { const was = S.settings.speech; S.settings.speech = true; speak(speechForMove(last)); S.settings.speech = was; }
      break;
    }
    case 'offer-draw':
      try { await S.provider.draw(S.game.id, true); toast('Zaproponowano remis.'); } catch (err) { toast(err.message); }
      break;
    case 'draw-yes': try { await S.provider.draw(S.game.id, true); } catch (err) { toast(err.message); } break;
    case 'draw-no': try { await S.provider.draw(S.game.id, false); } catch (err) { toast(err.message); } break;
    case 'takeback-ask':
      confirmModal({
        title: 'Poprosić o cofnięcie ruchu?',
        text: 'Rywal musi się zgodzić. Jeśli już odpowiedział, cofną się oba ruchy: jego i Twój. Czas na zegarze się nie zwraca.',
        okLabel: 'Poproś',
        onOk: async () => { try { await S.provider.takeback(S.game.id, true); toast('Poproszono o cofnięcie ruchu.'); } catch (err) { toast(err.message); } },
      });
      break;
    case 'takeback-yes': try { await S.provider.takeback(S.game.id, true); } catch (err) { toast(err.message); } break;
    case 'takeback-cancel': S.tbCancelled = true; // własne anulowanie — bez komunikatu „rywal odmówił”
    // fallthrough
    case 'takeback-no': try { await S.provider.takeback(S.game.id, false); } catch (err) { toast(err.message); } break;
    case 'resign':
      confirmModal({ title: 'Poddać partię?', okLabel: 'Poddaj', danger: true, onOk: async () => { try { await S.provider.resign(S.game.id); } catch (err) { toast(err.message); } } });
      break;
    case 'abort':
      confirmModal({ title: 'Przerwać partię?', text: 'Przed pierwszym ruchem partia nie liczy się do rankingu.', okLabel: 'Przerwij', onOk: async () => { try { await S.provider.abort(S.game.id); } catch (err) { toast(err.message); } } });
      break;
    case 'claim-win': try { await S.provider.claimVictory(S.game.id); } catch (err) { toast(err.message); } break;
    case 'claim-draw': try { await S.provider.claimDraw(S.game.id); } catch (err) { toast(err.message); } break;
    case 'game-menu': S.modal = { kind: 'game-menu' }; render(); break;
    case 'show-board':
      confirmModal({
        title: 'Pokazać pozycję?',
        text: 'To podgląd awaryjny — na wypadek, gdy bierki na Twojej szachownicy nie zgadzają się z partią.',
        okLabel: 'Pokaż',
        onOk: () => { S.modal = { kind: 'board' }; render(); },
      });
      break;
    case 'vote-up': S.voted = 'up-pending'; render(); break;
    case 'vote-down':
    case 'vote-skip':
    case 'vote-send': {
      const vote = a === 'vote-down' ? 'nie' : 'tak';
      const email = a === 'vote-send' ? (S.voteEmail || '').trim() : '';
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Sprawdź adres e-mail.'); break; }
      el.disabled = true;
      if (await sendFeedback(vote, email)) {
        S.voted = 'done'; lsSet('ps_vote', vote); toast('Dzięki! Głos zapisany.'); render();
      } else { el.disabled = false; }
      break;
    }
    case 'hide-banner': S.bannerHidden = true; lsSet('ps_banner_hidden', '1'); render(); break;
    default: break;
  }
});

app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.action === 'rated') { S.form.rated = el.checked; saveForm(); }
  if (el.dataset.action === 'setting') {
    S.settings[el.dataset.key] = el.checked; saveSettings();
    if (['sanEntry', 'englishNotation', 'learnMode'].includes(el.dataset.key)) { resetEntry(); S.entryMsg = ''; }
  }
});
// Formularze (Enter i przycisk „submit”); prawdziwe <form> pozwalają iPhone'owi zapisać hasło w Pęku kluczy.
app.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  unlockMedia();
  switch (f.dataset.form) {
    case 'account': await submitAccount(f.dataset.mode); break;
    case 'room-new': await submitRoom(); break;
    case 'club-join': await submitJoin(); break;
    case 'transfer': await submitTransferCode(); break;
    case 'friend-add': {
      const nick = (document.getElementById('friend-nick')?.value || '').trim();
      if (!nick) { toast('Wpisz nick gracza.'); break; }
      if (await social(() => S.provider.friendInvite(nick), `Wysłano zaproszenie do ${nick}.`)) {
        const i = document.getElementById('friend-nick'); if (i) i.value = '';
      }
      break;
    }
    case 'prompt': { const m = S.modal; const v = document.getElementById('prompt-input')?.value || ''; S.modal = null; render(); if (m?.onOk) await m.onOk(v); break; }
    case 'secure': {
      const v = (k) => document.getElementById(k)?.value ?? '';
      const password = v('sec-pass');
      if (password && password.length < 8) { toast('Hasło musi mieć co najmniej 8 znaków.'); break; }
      const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
      try {
        await S.provider.setPassword({ password: password || undefined, oldPassword: v('sec-old') || undefined, email: v('sec-email').trim() });
        S.modal = null; toast('Zapisano. Możesz logować się nickiem i hasłem na każdym urządzeniu.', 5000); render();
      } catch (err) { if (btn) btn.disabled = false; toast(err.message, 5000); }
      break;
    }
    default: break;
  }
});
// Akcja na liście znajomych: błąd jako komunikat, sukces opcjonalnym tekstem.
async function social(fn, okText) {
  try { await fn(); if (okText) toast(okText); render(); return true; } catch (err) { toast(err.message, 5000); return false; }
}
app.addEventListener('input', (e) => {
  if (e.target.id === 'friend-input') { S.form.friend = e.target.value; saveForm(); }
  if (e.target.id === 'vote-email') S.voteEmail = e.target.value;
  if (e.target.id === 'room-name') S.roomForm.name = e.target.value;
  if (e.target.id === 'room-nick') {
    if (S.view === 'account') S.accountForm.nick = e.target.value; else S.roomForm.nick = e.target.value;
  }
  if (e.target.id === 'acct-email') S.accountForm.email = e.target.value;
  if (e.target.id === 'acct-login') S.accountForm.nick = e.target.value;
});
app.addEventListener('toggle', (e) => {
  if (e.target.dataset?.action === 'room-history') {
    S.roomHistoryOpen = e.target.open;
    if (e.target.open && !S.roomHistory && !S.historyLoading) loadRoomHistory();
    return;
  }
  if (e.target.classList?.contains('history')) S.historyOpen = e.target.open;
  if (e.target.classList?.contains('transfer-card')) S.transferOpen = e.target.open;
}, true);

document.addEventListener('keydown', (e) => {
  if (S.modal) { if (e.key === 'Escape') { S.modal = null; render(); } return; }
  if (S.view !== 'game' || !S.game) return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (sanEntry()) {
    // notacja z klawiatury: wielkie litery = figury (K Q R B N, także polskie H W G S), małe a–h = kolumny
    const ch = e.key;
    let tok = null;
    if (/^[KQRBN]$/.test(ch)) tok = ch;
    else if (/^[HWGS]$/.test(ch)) tok = PL_TO_EN[ch];
    else if (/^[a-h1-8x=-]$/.test(ch)) tok = ch;
    else if (/^[oO0]$/.test(ch)) tok = 'O';
    if (tok) { e.preventDefault(); pressSan(tok); return; }
    if (k === 'backspace') { e.preventDefault(); backspace(); }
    else if (k === 'escape') { e.preventDefault(); clearInput(); }
    else if (k === 'enter') { e.preventDefault(); sendMove(); }
    return;
  }
  if (S.promo) {
    const map = { h: 'q', q: 'q', w: 'r', r: 'r', g: 'b', s: 'n', n: 'n' };
    if (map[k]) { e.preventDefault(); sendMove(map[k]); return; }
  }
  if (FILES.includes(k) || RANKS.includes(k)) { e.preventDefault(); pressKey(k); }
  else if (k === 'backspace') { e.preventDefault(); backspace(); }
  else if (k === 'escape') { e.preventDefault(); clearInput(); }
  else if (k === 'enter') { e.preventDefault(); sendMove(); }
});

// ---------------------------------------------------------------------------
// PWA
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator && !CONFIG.DEMO_ONLY) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
  // Nowa wersja aplikacji przejęła stronę: przeładuj, żeby ją pokazać — ale nigdy w trakcie partii
  // (wtedy przy najbliższym powrocie do listy partii).
  const hadController = !!navigator.serviceWorker.controller;
  let updateReady = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // pierwsza instalacja, nie aktualizacja
    updateReady = true;
    if (S.view !== 'game') location.reload();
  });
  app.addEventListener('click', (e) => {
    if (updateReady && e.target.closest('[data-action="back"]')) setTimeout(() => location.reload(), 0);
  });
}

boot();

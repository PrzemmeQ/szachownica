import { CONFIG } from './config.js';
import { Chess } from './chess.js';
import { LichessProvider } from './lichess.js';
import { DemoProvider } from './demo.js';
import {
  RoomsProvider, roomsEnabled, savedAccount, savedClubs, savedClub, myClubs, createRoom, lookupClub, joinClub,
  qrStart, qrPoll, forgetAllClubs, passkeySupported, passkeyPlatform, passkeyRegister, passkeyLogin, registerAccount, loginAccount, requestPasswordReset, resetPassword, restoreRoom,
  setAccountRooms,
} from './rooms.js';
import {
  sanToPl, describeMove, statusPl, speedPl, formatMs, PROMO_PIECES,
} from './notation.js';
import { t, tn, LANGS, currentLang, langInfo, setLang, initLang, fmtDate } from './i18n.js';
import { moveKeys, keysText, playRecorded } from './speech.js';

// ---------------------------------------------------------------------------
// Ustawienia użytkownika
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'ps_settings';
const DEFAULT_SETTINGS = { speech: true, vibrate: true, sound: true, autoSend: false, emergencyBoard: true, sanEntry: true, englishNotation: true, learnMode: false, readChat: true };
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
    mode: 'seek', preset: 'r10_5', rated: true, friend: '', color: 'random', level: 3, near: true,
    ...(() => { try { return JSON.parse(lsGet('ps_form') || '{}'); } catch { return {}; } })(),
  },
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
  const title = p.title ? `${p.title} ` : '';
  const r = p.rating ? ` (${p.rating}${p.provisional ? '?' : ''})` : '';
  return `${title}${p.name}${r}`;
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
// Głos syntezatora w języku aplikacji (polski albo wybrany).
const VOICE_LANG = { pl: 'pl-PL', en: 'en-GB' };
let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const want = currentLang();
  const voices = speechSynthesis.getVoices();
  voice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(want)) || null;
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
    u.lang = VOICE_LANG[currentLang()] || currentLang();
    if (voice) u.voice = voice;
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch {}
}
// Wypowiedź z kluczy (speech.js): nagrania, jeśli są, inaczej syntezator. extra — dopisany tekst (np. treść czatu).
async function say(keys, extra = '', force = false) {
  if (!force && !S.settings.speech) return;
  if (!extra && await playRecorded(keys)) return;
  const was = S.settings.speech;
  S.settings.speech = true;
  speak(keysText(keys) + (extra ? ' ' + extra : ''));
  S.settings.speech = was;
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
  await initLang(); // zapisany język (domyślnie polski)
  pickVoice();
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
    // Do Lichess wchodzimy od razu tylko po powrocie z logowania; poza tym zawsze ekran główny.
    if (lichess.hasToken() && (fromLogin || (!roomsEnabled() && lsGet('ps_last') !== 'menu'))) {
      await enterWith(lichess);
      return;
    }
  }
  S.view = 'start';
  render();
}

// Wariant B: wejście z linku (?klub=KOD, #qr=…, #reset=…, #nowy-pokoj). Bez linku zawsze ekran główny.
// Zwraca true, jeśli zajął się startem.
async function bootRoom() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('klub') || params.get('pokoj') || '').trim();
  // tokeny (logowanie QR, zmiana hasła) są po # — nie trafiają do logów serwera stron
  const hash = new URLSearchParams(location.hash.slice(1));
  const qr = (hash.get('qr') || '').trim();
  const friend = (hash.get('znajomy') || '').trim();
  const reset = (hash.get('reset') || '').trim();
  const clean = () => history.replaceState(null, '', location.pathname);
  if (location.hash === '#nowy-pokoj') { // ze strony dla klubów: od razu zakładanie klubu (najpierw konto)
    clean();
    if (!savedAccount()) { openAccount('register', 'room-new'); return true; }
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
  if (qr) { // kod QR z komputera zeskanowany aparatem telefonu (otwiera się przeglądarka)
    clean();
    if (!savedAccount()) {
      S.startError = t('Żeby zalogować komputer, najpierw zaloguj się tutaj. Albo otwórz aplikację, w której jesteś zalogowany, i użyj „Zaloguj komputer”.');
      S.view = 'start'; render();
      return true;
    }
    S.view = 'start'; render();
    await qrConfirm(qr);
    return true;
  }
  if (friend) { // link do znajomych: bez konta najpierw rejestracja, potem od razu znajomi
    clean();
    S.pendingFriendLink = friend;
    if (!savedAccount()) { openAccount('register', 'start'); return true; }
    S.view = 'start'; render();
    await friendLinkFlow();
    return true;
  }
  if (code) {
    clean();
    await openClubJoin(code);
    return true;
  }
  if (params.has('code') || params.has('error')) return false; // powrót z logowania Lichess
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
  lsSet('ps_last', provider.name);
  try {
    S.user = await provider.account();
    provider.userId = S.user.id;
  } catch (e) {
    S.provider = null;
    S.startError = e.message || (provider.features?.rooms ? t('Nie udało się połączyć z serwerem.') : t('Nie udało się połączyć z Lichess.'));
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
  S.roomHistory = null;
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
  S.roomHistory = null; S.modal = null; S.coach = null;
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
  // zaproszenie / oczekująca prośba: zawsze przez serwer (stary klucz z urządzenia mógł wygasnąć)
  const st = myClubs().find((x) => x.room === room)?.status || 'member';
  let c = st === 'member' ? savedClub(room) : null;
  if (!c) {
    S.waiting = { text: t('Otwieram klub…'), kind: 'pending' }; render();
    try { c = await restoreRoom(room); } catch (e) {
      S.waiting = null;
      toast(e.message, 5000);
      if (e.status === 404) setAccountRooms((savedAccount()?.rooms || []).filter((r) => r.room !== room)); // już nie należy
      render();
      return;
    }
    S.waiting = null;
  }
  await enterWith(new RoomsProvider(c));
}

// Zakładanie klubu.
async function submitRoom() {
  unlockMedia();
  const f = S.roomForm;
  const nick = f.nick.trim() || savedAccount()?.nick || '';
  if (!NICK_RE.test(nick)) { toast(t(NICK_ERR)); return; }
  if (!f.name.trim()) { toast(t('Wpisz nazwę klubu.')); return; }
  lsSet('ps_room_nick', nick);
  S.waiting = { text: t('Zakładam klub…'), kind: 'pending' }; render();
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
  if (!savedAccount()) { // do klubu dołącza się kontem; kod czeka do końca rejestracji/logowania
    S.pendingClubCode = code || '';
    openAccount('register', 'club-join');
    return;
  }
  S.joinRoom = { code: code || '', name: null, needsPassword: false, error: '', checked: false };
  S.view = 'club-join';
  render();
  if (code) await checkClubCode();
}
async function checkClubCode() {
  const j = S.joinRoom;
  const code = (document.getElementById('club-code')?.value ?? j.code).trim();
  if (!code) { toast(t('Wpisz kod klubu.')); return; }
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
  if (!NICK_RE.test(nick)) { toast(t(NICK_ERR)); return; }
  if (j.needsPassword && !password) { toast(t('Wpisz hasło klubu.')); return; }
  lsSet('ps_room_nick', nick);
  S.waiting = { text: t('Dołączam…'), kind: 'pending' }; render();
  try {
    const saved = await joinClub(j.code, nick, password);
    S.waiting = null; S.startError = '';
    if (saved.pending) { j.sent = true; render(); return; } // prośba czeka na założyciela/admina
    S.joinRoom = null;
    await enterWith(new RoomsProvider(saved));
  } catch (e) {
    S.waiting = null; j.error = e.message; render();
  }
}
// --- logowanie komputera telefonem (QR) --------------------------------------------
// Skrypty pomocnicze (generator i czytnik QR) wczytujemy dopiero, gdy są potrzebne.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src; s.onload = resolve; s.onerror = () => reject(new Error('' + t('Nie udało się wczytać') + ' ' + src));
    document.head.appendChild(s);
  });
}
function qrUrl(id) { return location.origin + location.pathname + '#qr=' + id; }
function qrSvg(text) {
  const q = window.qrcode(0, 'M');
  q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}
// Komputer: kod QR i krótki kod; co 2 s pyta, czy telefon zatwierdził.
async function startQrLogin() {
  stopQrLogin();
  S.view = 'qr-login'; S.qr = { loading: true }; render();
  try {
    await loadScript('vendor/qrcode.js');
    const q = await qrStart();
    S.qr = { ...q, svg: qrSvg(qrUrl(q.id)), until: Date.now() + q.expiresIn * 1000 };
    render();
    S.qr.timer = setInterval(pollQrLogin, 2000);
  } catch (e) { S.qr = { error: e.message }; render(); }
}
function stopQrLogin() { if (S.qr?.timer) clearInterval(S.qr.timer); }
async function pollQrLogin() {
  const q = S.qr;
  if (!q?.id || S.view !== 'qr-login') { stopQrLogin(); return; }
  try {
    const r = await qrPoll(q.id, q.secret);
    if (r.status === 'approved') {
      stopQrLogin(); S.qr = null;
      toast(t('Zalogowano jako {nick}.', { nick: r.saved.nick }));
      S.view = 'start'; render();
      offerPasskey();
    } else if (r.status === 'expired' || Date.now() > q.until) { stopQrLogin(); S.qr = { expired: true }; render(); }
    else { const c = document.getElementById('qr-left'); if (c) c.textContent = fmtCountdown(Math.max(0, Math.ceil((q.until - Date.now()) / 1000))); }
  } catch (e) { console.warn(e); }
}
// Telefon: zalogowane konto (połączenie z poczekalnią ogólną) — potrzebne do zatwierdzenia.
async function accountProvider() {
  if (S.provider?.isPublic) return S.provider;
  const acct = savedAccount();
  if (!acct) { openAccount('login', 'start'); return null; }
  await enterWith(new RoomsProvider(acct));
  return S.provider?.isPublic ? S.provider : null;
}
// Pytanie „Zalogować komputer jako …?” po zeskanowaniu albo wpisaniu kodu.
async function qrConfirm(code) {
  const p = await accountProvider();
  if (!p) return;
  let info;
  try { info = await p.qrInfo(code); } catch (e) { toast(e.message, 6000); return; }
  confirmModal({
    title: t('Zalogować {device} jako {v}?', { device: info.device, v: S.user?.name || '' }),
    text: t('Zatwierdzaj tylko kod z ekranu, który masz teraz przed sobą. Jeśli ktoś przysłał Ci ten kod albo pokazuje go na swoim urządzeniu — odrzuć: dostałby dostęp do Twojego konta.'),
    okLabel: t('Tak, zaloguj'), cancelLabel: t('Nie'),
    onOk: async () => { try { await p.qrApprove(code); toast(t('Zalogowano: {device}.', { device: info.device }), 5000); } catch (e) { toast(e.message, 6000); } },
  });
}
// Skaner QR w aplikacji (działa też w aplikacji z ekranu głównego iPhone'a).
async function openQrScanner() {
  if (!(await accountProvider())) return;
  S.modal = { kind: 'qr-scan' }; render();
  const video = document.getElementById('qr-video');
  if (!navigator.mediaDevices?.getUserMedia || !video) { S.scanError = t('Aparat niedostępny — wpisz kod z ekranu komputera.'); render(); return; }
  try {
    S.scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = S.scanStream; await video.play();
  } catch { S.scanError = t('Brak dostępu do aparatu — wpisz kod z ekranu komputera.'); render(); return; }
  let detector = null;
  if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {} }
  if (!detector) { try { await loadScript('vendor/jsQR.js'); } catch {} }
  const canvas = document.createElement('canvas');
  const tick = async () => {
    if (S.modal?.kind !== 'qr-scan' || !S.scanStream) return;
    let text = null;
    try {
      const video = document.getElementById('qr-video'); // po każdym render() to nowy element
      if (!video) { setTimeout(tick, 250); return; }
      if (detector) text = (await detector.detect(video))[0]?.rawValue || null;
      else if (window.jsQR && video.videoWidth) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0);
        text = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data || null;
      }
    } catch {}
    const m = text && text.match(/#qr=([A-Za-z0-9]+)/);
    if (m) { closeScanner(); await qrConfirm(m[1]); return; }
    setTimeout(tick, 250);
  };
  tick();
}
function closeScanner() {
  try { S.scanStream?.getTracks().forEach((t) => t.stop()); } catch {}
  S.scanStream = null; S.scanError = '';
  if (S.modal?.kind === 'qr-scan') S.modal = null;
}

// --- link do znajomych ---------------------------------------------------------------
async function friendLinkFlow() {
  const token = S.pendingFriendLink;
  if (!token || !savedAccount()) return;
  S.pendingFriendLink = '';
  const p = await accountProvider();
  if (!p) return;
  let info;
  try { info = await p.friendLinkInfo(token); } catch (e) { toast(e.message, 6000); return; }
  if (info.self) { toast(t('To Twój własny link — wyślij go znajomemu.'), 5000); return; }
  if (info.already) { toast(t('{nick} już jest Twoim znajomym.', { nick: info.nick })); return; }
  confirmModal({
    title: t('Dodać {nick} do znajomych?', { nick: info.nick }), text: t('Zobaczycie się na liście znajomych, gdy będziecie online, i wyzwiecie się jednym kliknięciem.'),
    okLabel: t('Tak, dodaj'), cancelLabel: t('Nie'),
    onOk: async () => { try { await p.friendLinkUse(token); toast(t('{nick} jest teraz Twoim znajomym.', { nick: info.nick }), 5000); render(); } catch (e) { toast(e.message, 6000); } },
  });
}
async function shareFriendLink() {
  try {
    const url = await S.provider.friendLinkCreate();
    const text = t('Zagraj ze mną w szachy na prawdziwej szachownicy — {app}', { app: CONFIG.APP_NAME });
    if (navigator.share) {
      try { await navigator.share({ title: CONFIG.APP_NAME, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(`${text}: ${url}`); toast(t('Skopiowano link — wklej go w WhatsAppie, SMS-ie albo e-mailu.'), 5000); }
    catch { S.modal = { kind: 'confirm', title: t('Link do znajomych'), text: url, okLabel: 'OK' }; render(); }
  } catch (e) { toast(e.message, 5000); }
}

// --- usunięcie konta (RODO) -------------------------------------------------------------
async function openDeleteAccount() {
  S.modal = { kind: 'delete-account', loading: true }; render();
  try { S.modal = { kind: 'delete-account', clubs: await S.provider.ownedClubs() }; } catch (e) { S.modal = null; toast(e.message); }
  render();
}
async function submitDeleteAccount() {
  const m = S.modal;
  const password = document.getElementById('del-pass')?.value || '';
  const decisions = {};
  for (const c of m.clubs || []) {
    const v = document.getElementById('del-club-' + c.room)?.value || '';
    if (!v) { toast(t('Wybierz, co z klubem „{name}”.', { name: c.name })); return; }
    decisions[c.room] = v;
  }
  if (!password) { toast(t('Wpisz hasło, żeby potwierdzić.')); return; }
  try {
    await S.provider.deleteAccount(password, decisions);
    S.modal = null; S.provider = null; S.user = null;
    S.view = 'start'; render();
    toast(t('Konto zostało usunięte. Dziękujemy za wspólne partie.'), 6000);
  } catch (e) { toast(e.message, 6000); }
}

// --- klucze dostępu (Face ID / odcisk palca / Windows Hello) --------------------------
const PASSKEY_NAME = 'Face ID / odcisk palca';
// Po zalogowaniu na urządzeniu z czytnikiem: jedno pytanie na urządzenie.
async function offerPasskey() {
  if (lsGet('ps_passkey_asked') || !savedAccount() || !(await passkeyPlatform())) return;
  if (S.modal) return; // inne pytanie na ekranie — zapytamy przy następnym logowaniu
  lsSet('ps_passkey_asked', '1');
  confirmModal({
    title: t('Włączyć logowanie Face ID / odciskiem palca?'),
    text: t('Następnym razem zalogujesz się jednym dotknięciem, bez wpisywania hasła. Hasło zostaje jako zapas. Klucz synchronizuje się przez iCloud albo konto Google.'),
    okLabel: t('Włącz'), cancelLabel: t('Nie teraz'),
    onOk: addPasskey,
  });
}
async function addPasskey() {
  try {
    const r = await passkeyRegister();
    if (!r) return; // anulowane
    if (S.provider?.me) S.provider.me.passkeys = r.passkeys;
    toast(t('Włączono logowanie: {name}.', { name: t(PASSKEY_NAME) }), 5000);
    render();
  } catch (e) { toast(e.message, 6000); }
}
async function loginWithPasskey() {
  try {
    const r = await passkeyLogin();
    if (!r) return;
    toast(t('Zalogowano jako {nick}.', { nick: r.saved.nick }));
    if (S.pendingFriendLink) { S.view = 'start'; render(); await friendLinkFlow(); return; }
    const f = S.accountForm;
    if (f.next === 'club-join') { const code = S.pendingClubCode || ''; S.pendingClubCode = ''; await openClubJoin(code); return; }
    if (f.next === 'room-new') { S.view = 'room-new'; render(); return; }
    S.view = 'start'; render();
  } catch (e) { toast(e.message, 6000); }
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
      if (!login) { toast(t('Wpisz nick albo e-mail.')); return; }
      S.waiting = { text: t('Wysyłam…'), kind: 'pending' }; render();
      const d = await requestPasswordReset(login);
      S.waiting = null;
      f.info = d.mailEnabled
        ? t('Jeśli to konto ma podany e-mail, wysłaliśmy na niego link do zmiany hasła (ważny 1 godzinę). Sprawdź też spam.')
        : t('Odzyskiwanie hasła e-mailem nie jest jeszcze włączone. Jeśli grasz jeszcze na innym urządzeniu, zmień hasło tam (menu Konto).');
      render();
      return;
    }
    if (password.length < 8 && kind !== 'login') { toast(t('Hasło musi mieć co najmniej 8 znaków.')); return; }
    const nick = f.nick.trim();
    if (kind !== 'reset' && !nick) { toast(t('Wpisz nick.')); return; }
    if (kind === 'register' && !NICK_RE.test(nick)) { toast(t(NICK_ERR)); return; }
    S.waiting = { text: kind === 'register' ? t('Zakładam konto…') : t('Loguję…'), kind: 'pending' }; render();
    if (kind === 'register') r = await registerAccount(nick, password, val('acct-email').trim());
    else if (kind === 'login') r = await loginAccount(nick, password);
    else r = await resetPassword(f.token, password);
    lsSet('ps_room_nick', r.saved.nick);
    // kluby przypięte do konta pojawią się w „Moje kluby” (otworzą się jednym kliknięciem)
    S.waiting = null;
    S.roomForm.nick = r.saved.nick;
    if (S.pendingFriendLink) { S.view = 'start'; render(); await friendLinkFlow(); return; } // link do znajomych z WhatsAppa
    offerPasskey(); // jedno pytanie o Face ID na urządzenie
    if (f.next === 'public') { await enterWith(new RoomsProvider(r.saved)); return; }
    if (f.next === 'room-new') { S.view = 'room-new'; render(); return; }
    if (f.next === 'club-join') { const code = S.pendingClubCode || ''; S.pendingClubCode = ''; await openClubJoin(code); return; }
    S.view = 'start';
    toast(kind === 'register' ? t('Konto {nick} założone.', { nick: r.saved.nick }) : t('Zalogowano jako {nick}.', { nick: r.saved.nick }));
    render();
  } catch (e) {
    S.waiting = null; toast(e.message, 5000); render();
  }
}

async function shareLink(url, title) {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast(t('Skopiowano link.')); }
  catch { toast(t('Skopiuj link ręcznie.')); }
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
        ? (S.provider.authRemoved ? t('Zostałeś usunięty z tego klubu.')
          : S.provider.isPublic ? t('Sesja konta wygasła — zaloguj się ponownie.') : t('Nie rozpoznano Cię w klubie — dołącz ponownie kodem klubu.'))
        : t('Sesja Lichess wygasła — zaloguj się ponownie.'), 6000);
      logout();
      break;
    case 'members': {
      if (S.provider?.me) S.user = { ...S.user, ratings: roomRatings(S.provider.me.ratings) };
      // nowa prośba o dołączenie — założyciel/admin słyszy sygnał
      const reqs = S.provider?.room?.requests || 0;
      if (reqs > (S.lastRequests || 0) && !quiet) { toast(t('Nowa prośba o dołączenie do klubu ({reqs}).', { reqs: reqs }), 5000); beep(); }
      S.lastRequests = reqs;
      if (S.view === 'coach' && reqs !== S.coachReqs) loadCoach();
      if (S.view === 'lobby' || S.view === 'coach') render();
      break;
    }
    case 'myRooms':
      if (S.view === 'start' || S.view === 'lobby') render();
      break;
    case 'clubStatus': {
      const msgs = {
        approved: t('Przyjęto Cię do klubu „{name}”. Otworzysz go w „Moich klubach” (Menu).', { name: ev.name }),
        rejected: t('Prośba o dołączenie do klubu „{name}” została odrzucona.', { name: ev.name }),
        invited: t('Zaproszenie do klubu „{name}”. Wejdziesz przez „Moje kluby” (Menu).', { name: ev.name }),
        deleted: t('Klub „{name}” został usunięty przez założyciela.', { name: ev.name }),
        owner: t('Jesteś teraz założycielem klubu „{name}”.', { name: ev.name }),
        expired: t('Prośba o dołączenie do klubu „{name}” wygasła.', { name: ev.name }),
      };
      if (msgs[ev.event]) { toast(msgs[ev.event], 7000); beep(); }
      break;
    }
    case 'seeks':
    case 'social':
      if (S.view === 'lobby') render();
      break;
    case 'friendInvite':
      toast(t('{from} zaprasza Cię do znajomych.', { from: ev.from }), 5000); beep(); // zdarzenie na żywo — nie z odtwarzania po połączeniu
      break;
    case 'friendJoined':
      toast(t('{nick} dołączył(a) do Twoich znajomych z Twojego linku.', { nick: ev.nick }), 6000); beep();
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
        toast(t('Nowa partia: {name}', { name: g.opponent.name }));
        beep();
        if (S.view === 'lobby') render();
      } else if (S.view === 'lobby') render();
      break;
    }
    case 'gameFinish': {
      // Lichess podaje zmianę rankingu po partii — pokaż ją na ekranie wyniku
      const G = S.game;
      if (G && G.id === ev.game.id && ev.game.ratingDiff != null && !G.spectator) {
        const d = ev.game.ratingDiff;
        G.ratingResult = { counted: true, diffW: G.myColor === 'white' ? d : null, diffB: G.myColor === 'black' ? d : null };
        if (S.view === 'game') render();
      }
    }
    // fallthrough
    case 'gameFinishList':
      S.ongoing = S.ongoing.filter((x) => x.id !== ev.game.id);
      if (S.roomHistory) loadRoomHistory();
      if (S.view === 'lobby') render();
      break;
    case 'challenge': {
      S.challenges.set(ev.challenge.id, ev.challenge);
      // rewanż od rywala, którego wynik właśnie oglądam — przycisk „Rewanż” zaczyna migać
      const rm = S.view === 'game' && rematchOffer();
      if (!quiet) { if (!rm) toast(t('Wyzwanie od {from}', { from: ev.challenge.from })); beep(); vibrate([80, 60, 80]); }
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
    if (result === 'declined') { S.waiting = null; toast(t('Rywal odrzucił wyzwanie.')); render(); return; }
    if (result === 'canceled') { S.waiting = null; toast(t('Wyzwanie anulowane.')); render(); return; }
    // połączenie zamknięte: albo para znaleziona (gameStart zaraz dotrze), albo wygasło
    setTimeout(() => {
      if (S.waiting === w) { S.waiting = null; toast(t('Nikt nie dołączył. Spróbuj jeszcze raz.')); render(); }
    }, 5000);
  }).catch((e) => {
    if (S.waiting !== w) return;
    S.waiting = null;
    if (e.name !== 'AbortError') toast(e.message || t('Błąd połączenia.'));
    render();
  });
}

async function startNewGame() {
  unlockMedia();
  const f = S.form;
  const p = presetById(f.preset);
  const opts = { time: p.time, increment: p.increment, days: p.days, rated: f.rated && !ratedBlockReason(), color: f.color };
  // Lichess: szukanie tylko wśród rywali ±100 od mojego rankingu w tym tempie
  if (S.provider?.name === 'lichess' && f.mode === 'seek' && f.near) {
    const r = S.user?.ratings?.[p.days ? 'correspondence' : p.group === 'Rapid' ? 'rapid' : 'classical'];
    if (r) opts.ratingRange = `${r - 100}-${r + 100}`;
  }
  try {
    if (f.mode === 'seek') {
      S.waiting = { text: t('Łączenie…'), kind: 'pending' }; render();
      const h = await S.provider.seek({ ...opts, color: undefined });
      if (h.matched) {
        // ktoś już czekał na to tempo — partia ruszyła (gameStart już otworzył ekran gry)
        if (S.waiting?.kind === 'pending') S.waiting = null;
        render();
        return;
      }
      if (h.correspondence) {
        S.waiting = null;
        toast(t('Ogłoszenie wystawione. Partia pojawi się na liście, gdy ktoś dołączy.'), 6000);
        render();
        return;
      }
      waitFor(h, `${t('Szukam rywala')} · ${t(p.group)} ${t(p.label)}${f.rated ? ' · ' + t('rankingowa') : ''}`);
    } else if (f.mode === 'friend') {
      const name = f.friend.trim();
      if (!/^[A-Za-z0-9_-]{2,30}$/.test(name)) { toast(t('Wpisz poprawny nick z Lichess.')); return; }
      S.waiting = { text: t('Wysyłanie wyzwania…'), kind: 'pending' }; render();
      const h = await S.provider.challenge(name, opts);
      if (h.correspondence) {
        S.waiting = null;
        toast(t('Wyzwanie wysłane do {name}. Partia pojawi się na liście po przyjęciu.', { name: name }), 6000);
        render();
        return;
      }
      waitFor(h, t('Czekam, aż {name} przyjmie wyzwanie', { name }));
    } else if (f.mode === 'member') {
      const opp = findPerson(f.opponent);
      if (!opp) { toast(S.provider.isPublic ? t('Wybierz znajomego, który jest online.') : t('Wybierz rywala z klubu.')); return; }
      S.waiting = { text: t('Wysyłanie wyzwania…'), kind: 'pending' }; render();
      const h = await S.provider.challenge(opp.id, opts);
      if (h.matched) { if (S.waiting?.kind === 'pending') S.waiting = null; render(); return; } // rywal wyzwał nas w tym samym czasie
      waitFor(h, t('Czekam, aż {name} przyjmie wyzwanie', { name: opp.nick }) + (opp.online ? '' : ' ' + t('(teraz poza klubem)')));
    } else {
      S.waiting = { text: t('Uruchamiam partię z komputerem…'), kind: 'pending' }; render();
      const { gameId } = await S.provider.challengeAI({ ...opts, level: f.level });
      S.waiting = null;
      openGame(gameId, f.color !== 'random' ? f.color : null);
    }
  } catch (e) {
    S.waiting = null;
    toast(e.message || t('Nie udało się rozpocząć partii.'));
    render();
  }
}

async function acceptChallenge(id) {
  unlockMedia();
  const c = S.challenges.get(id);
  S.waiting = { text: t('Przyjmuję wyzwanie{v}…', { v: c ? ' od ' + c.from : '' }), kind: 'accept' };
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
    lastSeenPly: null, conn: true, opponentGone: null, error: '', openedAt: Date.now(),
    clockAt: performance.now(), stream: null, announcedEnd: false,
  };
  S.game = G;
  S.view = 'game';
  resetEntry(); S.sending = false; S.entryMsg = ''; S.entryErr = false;
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
  postBoard(G);
}

// Szachownica testowa (szachownica.html) w innej karcie: dostaje pozycję, odsyła mój ruch do okienka wpisywania.
const boardChannel = 'BroadcastChannel' in window ? new BroadcastChannel('ps-plansza') : null;
function postBoard(G) {
  if (!boardChannel || !G?.full || G.spectator) return;
  boardChannel.postMessage({ type: 'state', gameId: G.id, myColor: G.myColor, moves: G.history.map((m) => m.from + m.to + (m.promotion || '')) });
}
boardChannel?.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'hello') postBoard(S.game);
  if (m.type === 'san' && S.view === 'game' && S.game && myTurn(S.game) && !S.sending) {
    const mv = S.game.chess.moves({ verbose: true }).find((x) => x.san === m.san);
    if (!mv) return;
    resetEntry();
    if (sanEntry()) S.san = mv.san; else S.input = [...(mv.from + mv.to)];
    if (!sanEntry() && mv.promotion) S.promo = { from: mv.from, to: mv.to };
    S.entryMsg = ''; S.entryErr = false;
    renderEntry();
  }
});

// Odmowa cofnięcia / remisu albo wygaśnięcie prośby, bo rywal zagrał — gracz ma o tym wiedzieć.
function announceDeclines(G, prev, prevPly) {
  const my = G.myColor === 'white' ? 'w' : 'b';
  const last = G.history[G.history.length - 1];
  const oppMoved = G.history.length > prevPly && last && last.color !== my;
  const iMoved = G.history.length > prevPly && last && last.color === my;
  const check = (flag, cancelledKey, sayKey, expired) => {
    if (!prev[flag] || G.state[flag]) return;
    if (S[cancelledKey]) { S[cancelledKey] = false; return; }
    if (iMoved || G.history.length < prevPly) return; // własny ruch albo przyjęte cofnięcie
    toast(oppMoved ? expired : keysText([sayKey]), 5000);
    if (!oppMoved) { beep(); vibrate([60, 40, 60]); say([sayKey]); }
  };
  check(my + 'takeback', 'tbCancelled', 'takeback-declined', t('Prośba o cofnięcie wygasła — rywal zagrał.'));
  check(my + 'draw', 'drawCancelled', 'draw-declined', t('Propozycja remisu wygasła — rywal zagrał.'));
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
          say(moveKeys(last));
          vibrate([80, 60, 80]);
          beep();
        }
        resetEntry(); S.entryMsg = ''; S.entryErr = false;
        G.opponentGone = null;
      }
      if (G.history.length < prevPly) {
        // cofnięcie ruchu: powiedz, które ruchy zniknęły, żeby poprawić bierki na szachownicy
        const undone = prevHistory.slice(G.history.length).map((m) => fmtSan(m.san)).join(', ');
        resetEntry();
        S.entryMsg = t('Cofnięto: {moves}. Ustaw bierki z powrotem na szachownicy.', { moves: undone });
        say(['takeback-done']);
        vibrate([60, 40, 60]);
      }
      G.lastSeenPly = G.history.length;
      if (!wasOver && gameOver(G) && !G.announcedEnd) {
        G.announcedEnd = true;
        releaseWakeLock();
        const st = G.state;
        say([st.status === 'aborted' || st.status === 'noStart' ? 'aborted' : !st.winner ? 'draw' : st.winner === G.myColor ? 'win' : 'loss']);
      }
      render();
      break;
    }
    case 'opponentGone': {
      const was = G.opponentGone;
      if (msg.gone) {
        // termin liczymy od chwili odebrania — odliczanie na żywo w updateClocks()
        G.opponentGone = { ...msg, deadline: Date.now() + (msg.claimWinInSeconds || 0) * 1000 };
        if (!was) { beep(); vibrate([200, 100, 200]); say(['opponent-gone']); }
      } else {
        G.opponentGone = null;
        if (was) { toast(t('Rywal wrócił do partii.')); beep(); }
      }
      render();
      break;
    }
    case 'rating':
      G.ratingResult = msg.result;
      render();
      break;
    case 'chat': { // Lichess: wiadomość rywala (bez komunikatów systemowych i własnych)
      const from = String(msg.user || '');
      if (msg.room !== 'player' || !from || from.toLowerCase() === 'lichess' || from.toLowerCase() === String(S.user?.name || '').toLowerCase()) break;
      G.lastChat = { user: from, text: String(msg.text || '').slice(0, 140) };
      if (Date.now() - (G.openedAt || 0) > 3000) { // bez odtwarzania starych wiadomości po otwarciu partii
        toast(`${from}: ${G.lastChat.text}`, 6000);
        if (S.settings.readChat !== false) say(['chat'], G.lastChat.text);
      }
      render();
      break;
    }
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
  if (st.status === 'aborted' || st.status === 'noStart') return { title: t('Partia przerwana'), sub: '' };
  if (st.winner) return { title: st.winner === G.myColor ? t('Wygrana') : t('Przegrana'), sub };
  return { title: t('Remis'), sub: sub === 'Remis' ? '' : sub };
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
    return prefix.length ? { state: 'partial', hints: prefix } : { state: 'bad', msg: t('Roszada nie jest teraz możliwa.') };
  }
  const p = key.match(SAN_RE);
  const none = () => (prefix.length ? { state: 'partial', hints: prefix } : { state: 'bad', msg: t('Nie ma takiego ruchu w tej pozycji.') });
  if (!p) return none();
  const [, piece, file, rank, to, promo] = p;
  // pobłażliwie: zbędne dookreślenie (Ngf3) albo bicie pionem bez kolumny (d5 zamiast exd5) też przejdzie
  const c = legal.filter((m) => m.piece === (piece ? piece.toLowerCase() : 'p') && m.to === to
    && (!file || m.from[0] === file) && (!rank || m.from[1] === rank)
    && (!promo || m.promotion === promo.toLowerCase()));
  if (!c.length) return none();
  const sans = [...new Set(c.map((m) => m.san))];
  if (new Set(c.map((m) => m.from)).size > 1) {
    return { state: 'ambiguous', hints: sans, msg: t('Na {to} mogą pójść: {moves} — dopisz kolumnę lub rząd, skąd rusza figura.', { to, moves: sans.map(fmtSan).join(', ') }) };
  }
  if (c.length > 1) return { state: 'promo', msg: t('Dopisz figurę promocji: {to}=Q (hetman), =R (wieża), =B (goniec), =N (skoczek).', { to }) };
  return { state: 'ok', move: c[0] };
}

function pressSan(tok) {
  const G = S.game;
  if (!G || !myTurn(G) || S.sending) return;
  if (tok === 'O-O' || tok === 'O-O-O') S.san = tok;
  else if (S.san.length < 8) S.san += tok;
  S.entryMsg = ''; S.entryErr = false;
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
  S.entryMsg = ''; S.entryErr = false;
  if (S.input.length === 2 && hintsOn(G)) {
    const from = S.input.join('');
    const own = G.chess.get(from);
    if (!own || own.color !== G.myColor[0]) { S.entryMsg = t('Na tym polu nie ma Twojej bierki.'); S.entryErr = true; }
    else if (!G.chess.moves({ square: from, verbose: true }).length) { S.entryMsg = t('Ta bierka nie ma teraz ruchu.'); S.entryErr = true; }
  }
  if (S.input.length === 4) {
    const check = validateInput();
    if (!check.ok) { if (hintsOn(G)) { S.entryMsg = check.msg; S.entryErr = true; } }
    else if (check.promotion) S.promo = { from: check.from, to: check.to };
    else if (S.settings.autoSend) { renderEntry(); sendMove(); return; }
  }
  renderEntry();
}
// Podpowiedzi przy wpisywaniu („Tryb nauki”): tylko w partiach towarzyskich i tylko po włączeniu w Ustawieniach.
function hintsOn(G) { return !!S.settings.learnMode && !!G?.full && !G.full.rated; }
// Ogólny komunikat po „Wyślij” bez podpowiadania, które figury wchodzą w grę.
function plainError(r) {
  if (r.state === 'ambiguous') return t('Ruch niejednoznaczny — dopisz kolumnę lub rząd, z którego rusza figura.');
  if (r.state === 'promo') return t('Dopisz figurę promocji: =Q, =R, =B albo =N.');
  return t('Niepoprawny ruch — sprawdź zapis.');
}
function backspace() {
  if (S.sending) return;
  if (sanEntry()) {
    S.san = /O-O(-O)?$/.test(S.san) ? '' : S.san.slice(0, -1);
  } else {
    if (S.promo) { S.promo = null; }
    S.input.pop();
  }
  S.entryMsg = ''; S.entryErr = false;
  renderEntry();
}
function clearInput() { if (S.sending) return; resetEntry(); S.entryMsg = ''; S.entryErr = false; renderEntry(); }

function validateInput() {
  const G = S.game;
  const from = S.input.slice(0, 2).join('');
  const to = S.input.slice(2, 4).join('');
  const cands = G.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!cands.length) {
    const own = G.chess.get(from);
    if (!own || own.color !== G.myColor[0]) return { ok: false, msg: t('Na polu {from} nie ma Twojej bierki.', { from }) };
    return { ok: false, msg: t('Ruch {from}–{to} jest niedozwolony w tej pozycji.', { from, to }) };
  }
  return { ok: true, from, to, promotion: cands.some((m) => m.promotion) };
}

async function sendMove(promoPiece) {
  const G = S.game;
  if (!G || !myTurn(G) || S.sending) return;
  let uci;
  if (sanEntry()) {
    const r = sanMatch(S.san);
    if (r.state !== 'ok') { S.entryMsg = hintsOn(G) ? (r.msg || t('Zapisz ruch, np. e4 albo Nf3.')) : plainError(r); S.entryErr = true; renderEntry(); return; }
    uci = r.move.from + r.move.to + (r.move.promotion || '');
  } else {
    if (S.input.length !== 4) { S.entryMsg = t('Wpisz pole startowe i docelowe, np. e2 e4.'); renderEntry(); return; }
    const check = validateInput();
    if (!check.ok) { S.entryMsg = hintsOn(G) ? check.msg : t('Niepoprawny ruch — sprawdź pola.'); S.entryErr = true; renderEntry(); return; }
    if (check.promotion && !promoPiece) { S.promo = { from: check.from, to: check.to }; renderEntry(); return; }
    uci = check.from + check.to + (promoPiece || '');
  }
  S.sending = true; S.entryMsg = t('Wysyłanie…'); S.entryErr = false; S.promo = null;
  renderEntry();
  try {
    await S.provider.move(G.id, uci);
    if (S.game === G) { resetEntry(); S.entryMsg = ''; S.entryErr = false; }
  } catch (e) {
    if (S.game === G) { S.entryMsg = e.message || t('Nie udało się wysłać ruchu.'); S.entryErr = true; }
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
  else if (S.view === 'qr-login') html = viewQrLogin();
  else if (S.view === 'account') html = viewAccount().replace(/<\/main>\s*$/, `<div class="start-others">${viewLangPicker()}</div></main>`); // wybór języka także przy logowaniu
  else if (S.view === 'lobby') html = viewLobby();
  else if (S.view === 'game') html = viewGame();
  else if (S.view === 'coach') html = viewCoach();
  html += viewWaiting() + viewModal();
  app.innerHTML = html;

  if (S.scanStream && S.modal?.kind !== 'qr-scan') closeScanner(); // okno zamknięte (Esc, kliknięcie obok) — wyłącz aparat
  // skaner QR: nowy element <video> po render() — podłącz ten sam obraz z aparatu
  const v = S.scanStream && document.getElementById('qr-video');
  if (v) { v.srcObject = S.scanStream; v.play().catch(() => {}); }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (selStart != null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selStart); } catch {} } }
  }
  updateClocks();
}

function viewLoading() {
  return `<main class="center"><p class="muted">${t('Łączenie…')}</p></main>`;
}

function viewLichessLogin(primary) {
  const cls = primary ? 'btn primary big' : 'btn big';
  if (CONFIG.DEMO_ONLY) {
    return `<p class="note">${t('To jest podgląd. Logowanie przez Lichess zadziała, gdy aplikacja będzie wgrana pod własny adres (instrukcja w README).')}</p>`;
  }
  return new LichessProvider().hasToken()
    ? `<button class="${cls}" data-action="lichess-resume">${t('Graj przez Lichess')}</button>
       <button class="link" data-action="lichess-logout">${t('Wyloguj z Lichess')}</button>`
    : `<button class="${cls}" data-action="login">${t('Zaloguj przez Lichess')}</button>
       <button class="link" data-action="token-login">${t('Inny sposób: wklej token Lichess')}</button>`;
}

function viewStart() {
  const err = S.startError ? `<p class="error">${esc(S.startError)}</p>` : '';
  const brand = `
    <div class="brand">
      <img class="logo-img" src="logo.svg" alt="" width="64" height="64">
      <h1>${esc(CONFIG.APP_NAME)}</h1>
    </div>`;
  if (!roomsEnabled()) {
    // wariant A: bez serwera pokoi
    return `
  <main class="start">
    ${brand}
    <p class="lead">${t('Grasz na prawdziwej szachownicy. Tutaj tylko wpisujesz swój ruch i odczytujesz ruch rywala — bez szachownicy na ekranie.')}</p>
    <p class="muted small">${t('Partie i ranking są na Twoim koncie Lichess.')}</p>
    ${err}
    <div class="stack">
      ${viewLichessLogin(true)}
      <button class="btn big" data-action="demo">${t('Wypróbuj bez logowania')}</button>
    </div>
    <p class="muted small">${t('Tempa od 10 minut — żeby był czas zagrać ruch na szachownicy i go wpisać. Przez Lichess: rapid, klasyczne i korespondencja.')}</p>
    ${viewBanner()}
  </main>`;
  }
  const acct = savedAccount();
  const clubs = acct ? myClubs() : [];
  const hint = S.standaloneHint ? `
    <div class="notice">${t('Aplikacja z ekranu głównego ma osobną pamięć od przeglądarki. Zaloguj się tu raz — zapamięta Cię.')}
      <button class="link small" data-action="hide-standalone">OK</button></div>` : '';
  // na dole: Lichess (wyraźny przycisk — duża baza graczy), potem drobne linki i wybór języka
  const lichessHas = !CONFIG.DEMO_ONLY && new LichessProvider().hasToken();
  const others = `
    <div class="start-others">
      ${CONFIG.DEMO_ONLY ? '' : `<p class="small">${t('Masz konto Lichess?')}</p>
      <button class="btn lichess-btn" data-action="${lichessHas ? 'lichess-resume' : 'login'}">${t('Zagraj na Lichess')}</button>
      <div class="small">${lichessHas ? '<button class="link small" data-action="lichess-logout">Wyloguj z Lichess</button>'
    : `<button class="link small" data-action="token-login">${t('Inny sposób: token Lichess')}</button>`}</div>`}
      <div class="small links-row"><button class="link small" data-action="demo">${t('Wypróbuj z komputerem (demo)')}</button> · <a class="small" href="${currentLang() === 'pl' ? 'kluby.html' : 'clubs.html'}">${t('Dla klubów i trenerów')}</a> · ${privacyLink()}</div>
      ${viewLangPicker()}
    </div>`;
  if (!acct) {
    // bez konta: zachęta do konta na górze, reszta drobnym drukiem
    return `
  <main class="start">
    ${brand}
    <p class="lead">${t('Grasz na prawdziwej szachownicy. Tu tylko wpisujesz swój ruch i słyszysz ruch rywala.')}</p>
    ${err}
    ${hint}
    <div class="stack">
      <button class="btn primary big" data-action="account-register">${t('Załóż konto')}</button>
      <button class="btn big" data-action="account-login">${t('Zaloguj się')}</button>
    </div>
    <p class="muted small center-text">${t('Tylko nick i hasło, bez e-maila. Ranking, znajomi, kluby i szybka gra — na każdym urządzeniu.')}</p>
    <p class="small center-text"><button class="link" data-action="qr-login">${t('Logujesz się na komputerze? Zaloguj telefonem (QR)')}</button></p>
    ${others}
  </main>`;
  }
  const clubsCard = `
    <section class="card mode-card">
      <h2>${t('Moje kluby')}</h2>
      ${clubs.length ? '' : `<p class="muted small">${t('Masz kod klubu od trenera albo znajomych? Dołącz. Możesz też założyć własny klub.')}</p>`}
      <div class="stack">${clubs.map((c) => `
        <button class="btn big mode-btn ${c.status === 'invited' ? 'primary' : ''}" data-action="open-club" data-id="${esc(c.room)}">${c.status === 'pending' ? '⏳' : c.status === 'invited' ? '✉️' : '👥'} ${esc(c.name)}<span class="mode-sub">${
  c.status === 'pending' ? t('czeka na zatwierdzenie przez założyciela lub admina')
    : c.status === 'invited' ? t('zaproszenie — kliknij, żeby wejść')
      : c.here ? `jako ${esc(c.nick)}` : t('zapisany na koncie — otwórz')}</span></button>`).join('')}
      </div>
      <div class="row-actions"><button class="btn small" data-action="club-join-open">${t('+ Dołącz do klubu')}</button> <button class="btn small" data-action="room-new">${t('+ Załóż klub')}</button></div>
    </section>`;
  return `
  <main class="start">
    <div class="brand-row">${brand}
      <button class="btn small" data-action="account-menu" aria-label="${t('Konto')}">${esc(acct.nick)} ▾</button></div>
    ${err}
    ${hint}
    <div class="stack">
      <button class="btn primary big mode-btn" data-action="quick-play">${t('⚡ Szybka gra')}<span class="mode-sub">${t('dobór rywala online, znajomi, ranking ogólny')}</span></button>
    </div>
    ${clubsCard}
    <p class="small center-text"><button class="link" data-action="qr-scan">${t('📷 Zaloguj komputer (skanuj kod QR)')}</button></p>
    ${others}
  </main>`;
}

// Wybór języka: mała flaga + nazwa; po kliknięciu lista alfabetyczna (flaga, nazwa w tym języku).
function viewLangPicker() {
  const cur = langInfo();
  return `
    <div class="lang-picker">
      <button class="lang-btn" data-action="lang-open" aria-haspopup="listbox" aria-expanded="${S.langOpen ? 'true' : 'false'}" aria-label="${t('Język')}: ${esc(cur.name)}">
        <img src="${cur.flag}" alt="" width="20" height="13"> ${esc(cur.name)} ▾</button>
      ${S.langOpen ? `<ul class="lang-list" role="listbox">${LANGS.map((l) => `
        <li><button class="lang-opt ${l.code === cur.code ? 'sel' : ''}" role="option" aria-selected="${l.code === cur.code}" data-action="lang-set" data-id="${l.code}">
          <img src="${l.flag}" alt="" width="20" height="13"> ${esc(l.name)}</button></li>`).join('')}</ul>` : ''}
    </div>`;
}

// Komputer: kod QR do zeskanowania zalogowanym telefonem.
function viewQrLogin() {
  const q = S.qr || {};
  const back = `<header class="g-top"><button class="btn small" data-action="qr-cancel">${t('← Wróć')}</button></header>`;
  let body;
  if (q.loading) body = `<p class="muted">${t('Przygotowuję kod…')}</p>`;
  else if (q.error) body = `<p class="error">${esc(q.error)}</p><div class="stack"><button class="btn primary" data-action="qr-login">${t('Spróbuj ponownie')}</button></div>`;
  else if (q.expired) body = `<p class="note">${t('Kod wygasł.')}</p><div class="stack"><button class="btn primary" data-action="qr-login">${t('Pokaż nowy kod')}</button></div>`;
  else {
    body = `
    <div class="qr-box">${q.svg}</div>
    <ol class="small">
      <li>${t('Na telefonie otwórz aplikację, w której jesteś zalogowany.')}</li>
      <li>${t('Ekran główny →')} <strong>${t('„📷 Zaloguj komputer”')}</strong> ${t('i zeskanuj ten kod.')}</li>
      <li>${t('Potwierdź na telefonie — ten ekran zaloguje się sam.')}</li>
    </ol>
    <p class="small">${t('Aparat nie działa? Na telefonie wpisz kod:')} <span class="club-code inline" id="qr-short">${esc(q.short)}</span></p>
    <p class="muted small">${t('Kod ważny jeszcze')} <b id="qr-left">${fmtCountdown(Math.max(0, Math.ceil((q.until - Date.now()) / 1000)))}</b>${t(', działa raz.')}</p>`;
  }
  return `
  <main class="start">${back}
    <h1>${t('Zaloguj telefonem')}</h1>
    ${body}
  </main>`;
}

// strona prywatności w języku aplikacji (angielska: privacy.html)
const privacyLink = () => `<a href="${currentLang() === 'pl' ? 'prywatnosc.html' : 'privacy.html'}" target="_blank" rel="noopener">${t('Prywatność')}</a>`;
const NICK_INPUT = (value, placeholder) => `<input id="room-nick" name="username" type="text" maxlength="20" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(value)}" placeholder="${placeholder}">`;

// Konto: rejestracja / logowanie / nie pamiętam hasła / nowe hasło z linku.
function viewAccount() {
  const f = S.accountForm;
  const back = `<header class="g-top"><button class="btn small" data-action="to-start">${t('← Wróć')}</button></header>`;
  const pass = (id, label, auto) => `
    <label class="field">${t(label)}
      <input id="${id}" name="password" type="password" autocomplete="${auto}" value="">
    </label>`;
  // prawdziwe formularze <form> — iPhone (Pęk kluczy) i menedżery haseł proponują wtedy zapisanie hasła
  const form = (mode, inner) => `<form data-form="account" data-mode="${mode}" method="post" action="#">${inner}</form>`;
  if (f.mode === 'forgot') {
    return `
  <main class="start">${back}
    <h1>${t('Nie pamiętam hasła')}</h1>
    <p class="lead">${t('Wyślemy link do ustawienia nowego hasła na e-mail podany przy koncie.')}</p>
    ${form('forgot', `
    <label class="field">${t('Nick albo e-mail')}
      <input id="acct-login" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(f.nick)}">
    </label>
    ${f.info ? `<p class="note small">${esc(f.info)}</p>` : ''}
    <div class="stack"><button type="submit" class="btn primary big">${t('Wyślij link')}</button></div>`)}
    <p class="small"><button class="link" data-action="acct-mode" data-id="login">${t('← Wróć do logowania')}</button></p>
  </main>`;
  }
  if (f.mode === 'reset') {
    return `
  <main class="start">${back}
    <h1>${t('Nowe hasło')}</h1>
    ${form('reset', `
    ${pass('acct-pass', 'Nowe hasło (min. 8 znaków)', 'new-password')}
    <div class="stack"><button type="submit" class="btn primary big">${t('Ustaw hasło i zaloguj')}</button></div>`)}
  </main>`;
  }
  if (f.mode === 'login') {
    return `
  <main class="start">${back}
    <h1>${t('Zaloguj się')}</h1>
    <p class="lead">${t('Twój ranking, znajomi i kluby wrócą na tym urządzeniu.')}</p>
    ${form('login', `
    <label class="field">${t('Nick')} ${NICK_INPUT(f.nick, '')}</label>
    ${pass('acct-pass', 'Hasło', 'current-password')}
    <div class="stack"><button type="submit" class="btn primary big">${t('Zaloguj się')}</button></div>`)}
    <div class="stack">
      ${passkeySupported() ? `<button class="btn big" data-action="passkey-login">${t('Zaloguj Face ID / odciskiem palca')}</button>` : ''}
      <button class="btn" data-action="qr-login">${t('Zaloguj telefonem (kod QR)')}</button>
    </div>
    <p class="small"><button class="link" data-action="acct-mode" data-id="forgot">${t('Nie pamiętam hasła')}</button></p>
    <p class="small">${t('Nie masz konta?')} <button class="link" data-action="acct-mode" data-id="register">${t('Załóż konto')}</button></p>
  </main>`;
  }
  return `
  <main class="start">${back}
    <h1>${t('Załóż konto')}</h1>
    <p class="lead">${f.next === 'club-join' || f.next === 'room-new' ? '' + t('Do klubu potrzebne jest konto — wystarczy nick i hasło, bez e-maila.') + ' ' : ''}${t('Konto trzyma ranking, znajomych i kluby — zalogujesz się na każdym urządzeniu. Bez konta Lichess.')}</p>
    ${form('register', `
    <label class="field">${t('Nick (widoczny dla innych graczy)')} ${NICK_INPUT(f.nick, 'np. Ania_K')}</label>
    ${pass('acct-pass', 'Hasło (min. 8 znaków)', 'new-password')}
    <p class="note small">${t('Wymyśl')} <strong>${t('nowe hasło, którego nie używasz nigdzie indziej')}</strong> ${t('(np. do poczty czy banku). Najlepiej kilka słów, np. „zielony-goniec-na-b5”. Zbyt popularnych haseł aplikacja nie przyjmie.')}</p>
    <label class="field">E-mail <span class="muted">${t('(nieobowiązkowy — tylko do odzyskania hasła)')}</span>
      <input id="acct-email" name="email" type="email" autocomplete="email" inputmode="email" value="${esc(f.email)}" placeholder="adres@e-mail.pl">
    </label>
    <div class="stack"><button type="submit" class="btn primary big">${t('Załóż konto')}</button></div>`)}
    <p class="small">${t('Masz już konto?')} <button class="link" data-action="acct-mode" data-id="login">${t('Zaloguj się')}</button></p>
    <p class="note small">${t('W szybkiej grze grasz z nieznajomymi. Nie da się sprawdzić, czy ktoś gra przy szachownicy, czy z programem — z kimś, komu ufasz, zagrasz w klubie.')}</p>
    <p class="muted small">${t('Zapisujemy nick, skrót hasła (nie samo hasło), e-mail tylko jeśli go podasz, partie, ranking i listę znajomych.')} ${privacyLink()}</p>
  </main>`;
}

function viewRoomNew() {
  const f = S.roomForm;
  const acct = savedAccount();
  return `
  <main class="start">
    <header class="g-top"><button class="btn small" data-action="to-start">${t('← Wróć')}</button></header>
    <h1>${t('Nowy klub')}</h1>
    <p class="lead">${t('Zamknięta grupa dla znajomych, klubu albo szkółki. Ranking jest wspólny z poczekalnią ogólną (jeden na tempo).')}</p>
    <form data-form="room-new" autocomplete="off">
      <label class="field">${t('Nazwa klubu')}
        <input id="room-name" type="text" maxlength="40" autocomplete="off" value="${esc(f.name)}" placeholder="${t('np. Klub Hetman — środy')}">
      </label>
      <label class="field">${t('Twój nick w klubie')} ${NICK_INPUT(f.nick || acct?.nick || '', 'np. Ania')}</label>
      <p class="muted small">${t('Klub zapisze się na koncie')} ${esc(acct?.nick || '')} ${t('— wrócisz do niego po zalogowaniu na innym urządzeniu.')}</p>
      <div class="stack"><button type="submit" class="btn primary big">${t('Załóż klub')}</button></div>
    </form>
    <p class="muted small">${t('Dostaniesz kod klubu (np. HETMA-7Q4MX) i link do wysłania. Nowi członkowie dołączają kontem i czekają na Twoje zatwierdzenie (można to wyłączyć). Możesz też dodawać graczy po nicku, zmienić kod i ustawić hasło klubu.')}</p>
    <p class="muted small">${t('Zapisujemy tylko nick, przynależność do klubu i partie.')} ${privacyLink()}</p>
  </main>`;
}

// Dołączanie do klubu: kod → (nazwa klubu) → nick i ewentualnie hasło klubu.
function viewClubJoin() {
  const j = S.joinRoom || { code: '' };
  const f = S.roomForm;
  const acct = savedAccount();
  if (j.sent) {
    return `
  <main class="start">
    <header class="g-top"><button class="btn small" data-action="to-start">${t('← Menu')}</button></header>
    <h1>${t('Prośba wysłana')}</h1>
    <p class="lead">${t('Klub')} <strong>${esc(j.name)}</strong> ${t('przyjmuje nowych członków po zatwierdzeniu. Założyciel albo administrator zobaczy Twoją prośbę.')}</p>
    <p class="note small">${t('Klub czeka w „Moich klubach” z dopiskiem „czeka na zatwierdzenie”. Gdy Cię przyjmą, dostaniesz powiadomienie (jeśli masz otwartą aplikację) i klub otworzy się jednym kliknięciem. Prośba ważna 7 dni.')}</p>
    <div class="stack"><button class="btn primary big" data-action="to-start">${t('Wróć do menu')}</button></div>
  </main>`;
  }
  const step2 = j.checked ? `
      <p class="lead">${t('Klub')} <strong>${esc(j.name)}</strong></p>
      <label class="field">${t('Twój nick w klubie')} ${NICK_INPUT(f.nick || acct?.nick || '', 'np. Bartek')}</label>
      ${j.needsPassword ? `<label class="field">${t('Hasło klubu')} <input id="club-pass" type="password" autocomplete="off"></label>` : ''}
      <p class="muted small">${t('Klub zapisze się na koncie')} ${esc(acct?.nick || '')}${t('. Jeśli klub zatwierdza nowych członków, najpierw poczekasz na zgodę założyciela albo admina.')}</p>
      <div class="stack"><button type="submit" class="btn primary big">${t('Dołącz')}</button></div>` : `
      <div class="stack"><button type="submit" class="btn primary big">${t('Dalej')}</button></div>`;
  return `
  <main class="start">
    <header class="g-top"><button class="btn small" data-action="to-start">${t('← Wróć')}</button></header>
    <h1>${t('Dołącz do klubu')}</h1>
    <form data-form="club-join" autocomplete="off">
      <label class="field">${t('Kod klubu')}
        <input id="club-code" type="text" maxlength="16" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${esc(j.code)}" placeholder="${t('np. HETMA-7Q4MX')}" ${j.checked ? 'readonly' : ''}>
      </label>
      ${j.checked ? `<p class="small"><button type="button" class="link" data-action="club-code-change">${t('Inny kod')}</button></p>` : ''}
      ${j.error ? `<p class="error">${esc(j.error)}</p>` : ''}
      ${step2}
    </form>
    <p class="muted small">${t('Kod dostaniesz od założyciela klubu albo trenera. Po kilku błędnych próbach dołączanie do klubów zostaje zablokowane na pewien czas.')} ${privacyLink()}</p>
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
      || t('Ranking pojawi się po pierwszej partii rankingowej');
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
        <span class="row-sub">${esc(speedPl(g.speed))} ${t('· grasz')} ${g.color === 'white' ? t('białymi') : t('czarnymi')}</span>
        <span class="pill ${g.isMyTurn ? 'pill-on' : ''}">${g.isMyTurn ? t('Twój ruch') : 'czekasz'}</span>
      </button>`).join('')
    : `<p class="muted small">${t('Brak trwających partii.')}</p>`;

  const chal = [...S.challenges.values()];
  const challenges = chal.length ? `
    <section class="card">
      <h2>${t('Wyzwania')}</h2>
      ${chal.map((c) => `
        <div class="row static">
          <span class="row-main">${esc(c.from)}${c.rating ? ` <span class="muted">(${c.rating})</span>` : ''}</span>
          <span class="row-sub">${esc(speedPl(c.speed))} ${esc(c.label)}${c.rated ? ' ' + t('· rankingowa') + '' : ''}</span>
          ${c.compatible
            ? `<span class="row-actions"><button class="btn small primary" data-action="accept" data-id="${esc(c.id)}">${t('Przyjmij')}</button><button class="btn small" data-action="decline" data-id="${esc(c.id)}">${t('Odrzuć')}</button></span>`
            : `<span class="row-sub warn">${t('Tego tempa lub wariantu nie da się grać przez API.')}</span><span class="row-actions"><button class="btn small" data-action="decline" data-id="${esc(c.id)}">${t('Odrzuć')}</button></span>`}
        </div>`).join('')}
    </section>` : '';

  const rooms = !!S.provider?.features?.rooms;
  return `
  <main class="lobby">
    <header class="topbar">
      <div>
        <div class="who">${esc(S.user?.name || '')}${demo ? ' <span class="pill">demo</span>' : ''}${rooms ? ` <span class="muted">· ${esc(S.provider.roomName)}</span>` : ''}</div>
        <div class="muted small">${esc(ratingsLine()) || (demo ? t('Tryb demo — bez rankingu') : '')}</div>
      </div>
      <div class="topbar-actions">
        <span class="dot ${S.online ? 'on' : 'off'}" title="${S.online ? t('Połączono') : t('Łączenie…')}"></span>
        ${rooms ? `<button class="icon-btn" data-action="room-menu" aria-label="${S.provider.isPublic ? t('Konto') : t('Klub')}">⌂</button>` : ''}
        <button class="icon-btn" data-action="settings" aria-label="${t('Ustawienia')}">⚙︎</button>
        ${rooms ? '' : `<button class="icon-btn" data-action="logout" aria-label="${t('Wyloguj')}">⏻</button>`}
        <button class="btn small" data-action="to-menu">${t('Menu')}</button>
      </div>
    </header>

    ${!S.online && rooms ? `<div class="notice">${t('Brak połączenia z serwerem — łączę ponownie…')}</div>` : ''}
    ${rooms && S.provider.isPublic && S.provider.me && !S.provider.me.hasPassword
    ? `<div class="notice">${t('Konto bez hasła — ranking jest tylko na tym urządzeniu.')} <button class="btn small primary" data-action="secure-open">${t('Ustaw hasło')}</button></div>` : ''}

    ${challenges}

    <section class="card">
      <h2>${t('Trwające partie')}</h2>
      ${ongoing}
    </section>

    ${viewNewGame()}

    ${rooms && isCoach() && S.provider.room?.requests ? `<div class="notice req-note">${t('Prośby o dołączenie do klubu:')} <strong>${S.provider.room.requests}</strong>
      <button class="btn small primary" data-action="coach-open">${t('Zobacz')}</button></div>` : ''}
    ${rooms && S.provider.isPublic ? viewFriends() : ''}
    ${rooms && isCoach() ? `<section class="card"><h2>${t('Panel trenera')}</h2>
      <p class="muted small">${t('Jako')} ${S.provider.me?.role === 'owner' ? t('założyciel') : 'administrator'} ${t('klubu widzisz partie wszystkich członków (podgląd na żywo, wyniki, zapis do analizy) i zarządzasz członkami.')}</p>
      <button class="btn small primary" data-action="coach-open">${t('Otwórz panel trenera')}</button></section>` : ''}
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
        ${pub ? '' : `<span class="dot ${m.online ? 'on' : 'off'}" title="${m.online ? t('w klubie') : t('poza klubem')}"></span>`}
        <span class="rank-nick">${esc(m.nick)}${m.id === meId ? ' <span class="muted small">(Ty)</span>' : ''}</span>
        <span class="rank-r">${r?.games ? esc(roomRating(r)) : '<span class="muted small">—</span>'}</span>
        <span class="rank-g muted small">${r?.games || 0} p.</span>
      </li>`;
  }).join('');
  return `
  <section class="card">
    <h2>${pub ? t('Ranking ogólny') : t('Członkowie klubu')}</h2>
    <div class="tabs">${RATING_SPEEDS.map(([k, l]) => `<button class="tab ${sp === k ? 'sel' : ''}" data-action="rank-speed" data-id="${k}">${t(l)}</button>`).join('')}</div>
    <ol class="rank-list">${rows}</ol>
    <p class="muted small">${pub ? '' + t('Czołówka (20 najlepszych) i Ty.') + ' ' : '' + t('Ranking jest wspólny dla poczekalni i wszystkich klubów (jeden na tempo, start 1200).') + ' '}${t('„?” — ranking jeszcze niepewny (mało partii). Liczą się tylko partie rankingowe.')}</p>
    ${pub ? '' : `<button class="btn small" data-action="room-menu">${t('Zaproś do klubu')}</button>`}
  </section>`;
}

const RESULT_PL = { white: '1–0', black: '0–1' };
function viewRoomHistory() {
  const h = S.roomHistory;
  let body;
  if (!h) body = `<p class="muted small">${S.historyLoading ? t('Wczytywanie…') : ''}</p>`;
  else if (!h.length) body = `<p class="muted small">${t('Jeszcze nie rozegrano żadnej partii.')}</p>`;
  else {
    body = `<ul class="hist-list">${h.map((g) => {
      const res = g.status === 'aborted' || g.status === 'noStart' ? 'przerw.' : RESULT_PL[g.winner] || '½–½';
      const diff = (d) => (d == null ? '' : ` <span class="muted small">${d > 0 ? '+' : ''}${d}</span>`);
      return `<li>
        <span class="hist-players">${esc(g.white)}${diff(g.diffW)} – ${esc(g.black)}${diff(g.diffB)}</span>
        <span class="hist-res">${res}</span>
        <span class="muted small">${esc(speedPl(g.speed))} ${esc(g.label)} · ${esc(statusPl(g.status))}${g.rated ? '' : ' ' + t('· towarzyska') + ''} · ${new Date(g.endedAt).toLocaleDateString('pl-PL')}${(isCoach() || g.whiteId === S.user?.id || g.blackId === S.user?.id) && g.plies
    ? ` · <button class="link small" data-action="game-analysis" data-id="${esc(g.id)}">analiza</button> · <button class="link small" data-action="game-pgn" data-id="${esc(g.id)}">PGN</button>` : ''}</span>
      </li>`;
    }).join('')}</ul>`;
  }
  return `
  <details class="card room-hist" data-action="room-history" ${S.roomHistoryOpen ? 'open' : ''}>
    <summary>${S.provider.features?.public ? t('Twoje partie') : t('Historia partii w klubie')}</summary>
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
  if (!p.me?.account) return t('Partie rankingowe wymagają konta — załóż je na ekranie startowym (Konto).');
  if (!p.isPublic && S.form.mode === 'member') {
    const opp = findPerson(S.form.opponent);
    if (opp && !opp.account) return t('{nick} nie ma konta — z tą osobą zagrasz tylko towarzysko.', { nick: opp.nick });
  }
  return '';
}
function viewFriends() {
  const s = S.provider.social;
  if (!s) return `<section class="card"><h2>${t('Znajomi')}</h2><p class="muted small">${t('Wczytywanie…')}</p></section>`;
  const person = (p, actions) => `
    <li class="friend-row">
      <span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'online' : 'offline'}"></span>
      <span class="friend-nick">${esc(p.nick)}${p.rating ? ` <span class="muted small">(${p.rating})</span>` : ''}</span>
      <span class="row-actions">${actions}</span>
    </li>`;
  const btn = (action, id, label, cls = '') => `<button class="btn small ${cls}" data-action="${action}" data-id="${esc(id)}">${t(label)}</button>`;
  const challenge = (p) => (p.online ? btn('friend-challenge', p.id, 'Wyzwij', 'primary') : '');
  const sec = (title, list, fn) => (list?.length ? `<h3>${t(title)}</h3><ul class="friend-list">${list.map(fn).join('')}</ul>` : '');
  return `
  <section class="card friends">
    <h2>${t('Znajomi')}</h2>
    ${sec('Zaproszenia do znajomych', s.incoming, (p) => person(p, btn('friend-accept', p.id, 'Przyjmij', 'primary') + btn('friend-decline', p.id, 'Odrzuć')))}
    ${s.friends?.length ? sec('Twoi znajomi', s.friends, (p) => person(p, challenge(p) + btn('friend-more', p.id, '⋯')))
    : `<p class="muted small">${t('Nie masz jeszcze znajomych. Zaproś kogoś nickiem albo z listy ostatnich rywali.')}</p>`}
    ${sec('Ostatni rywale', s.recent, (p) => person(p, challenge(p) + btn('friend-invite-id', p.id, 'Zaproś') + btn('friend-block', p.id, 'Zablokuj')))}
    ${sec('Wysłane zaproszenia', s.outgoing, (p) => person(p, btn('friend-cancel', p.id, 'Anuluj')))}
    <div class="row-actions"><button class="btn small primary" data-action="friend-link">${t('Zaproś linkiem (WhatsApp, SMS…)')}</button></div>
    <p class="muted small">${t('Link działa raz, przez 7 dni. Kto go otworzy, zostanie Twoim znajomym — także po założeniu konta.')}</p>
    <form data-form="friend-add" class="inline-form" autocomplete="off">
      <input id="friend-nick" type="text" maxlength="20" autocapitalize="off" spellcheck="false" placeholder="${t('Nick gracza')}" aria-label="${t('Nick gracza do zaproszenia')}">
      <button type="submit" class="btn small">${t('Zaproś do znajomych')}</button>
    </form>
    ${s.blocked?.length ? `<details class="blocked"><summary class="small">${t('Zablokowani (')}${s.blocked.length})</summary>
      <ul class="friend-list">${s.blocked.map((p) => person({ ...p, online: false }, btn('friend-unblock', p.id, 'Odblokuj'))).join('')}</ul></details>` : ''}
    <p class="muted small">${t('Zablokowana osoba nie może Cię wyzwać ani zaprosić. Nie dowie się o blokadzie.')}</p>
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
      <div class="muted small">${t(g)}</div>
      <div class="chips">
        ${allowed.filter((p) => p.group === g).map((p) => `
          <button class="chip ${f.preset === p.id ? 'sel' : ''}" data-action="preset" data-id="${p.id}">${t(p.label)}</button>`).join('')}
      </div>
    </div>`).join('');

  const friend = f.mode === 'friend' ? `
    <label class="field">${t('Nick znajomego na Lichess')}
      <input id="friend-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(f.friend)}" placeholder="${t('np. jan_kowalski')}">
    </label>` : '';
  let member = '';
  if (f.mode === 'member') {
    // poczekalnia: tylko znajomi i ostatni rywale, którzy są teraz online (bez listy wszystkich graczy)
    const others = pub ? opponentsOnline()
      : (S.provider.members || []).filter((m) => m.id !== S.user?.id)
        .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.nick.localeCompare(b.nick, 'pl'));
    if (!others.find((m) => m.id === f.opponent)) f.opponent = others.find((m) => m.online)?.id || others[0]?.id || '';
    member = others.length ? `
    <div class="field">${t('Rywal')}
      <div class="chips">${others.map((m) => `<button class="chip ${f.opponent === m.id ? 'sel' : ''}" data-action="opponent" data-id="${esc(m.id)}"><span class="dot ${m.online ? 'on' : 'off'}"></span> ${esc(m.nick)}${m.friend ? ' ★' : ''}</button>`).join('')}</div>
    </div>`
      : pub ? `<p class="note small">${t('Nikt ze znajomych ani ostatnich rywali nie jest teraz online. Dodaj znajomych niżej albo poszukaj rywala w zakładce „Poczekalnia”.')}</p>`
        : `<p class="note small">${t('W klubie nie ma jeszcze nikogo poza Tobą.')} <button class="link" data-action="room-menu">${t('Zaproś kogoś')}</button></p>`;
  }
  let seekList = '';
  if (rooms && f.mode === 'seek') {
    const seeks = (S.provider.seeks || []).filter((s) => s.memberId !== S.user?.id);
    seekList = `
    <div class="field">${t('Czekają na rywala')}
      ${seeks.length ? `<ul class="seek-list">${seeks.map((s) => `
        <li>
          <span class="seek-who">${esc(s.nick)} <span class="muted">(${s.rating})</span></span>
          <span class="muted small">${esc(speedPl(s.speed))} ${esc(s.label)}${s.rated ? ' ' + t('· rankingowa') + '' : ' ' + t('· towarzyska') + ''}</span>
          <button class="btn small primary" data-action="seek-accept" data-id="${esc(s.id)}">${t('Graj')}</button>
        </li>`).join('')}</ul>`
    : `<p class="muted small">${t('Nikt teraz nie czeka. Wybierz tempo i szukaj — aplikacja połączy Cię z pierwszą osobą, która wybierze to samo tempo.')}</p>`}
    </div>`;
  }
  const level = f.mode === 'ai' && !demo ? `
    <div class="field">${t('Poziom komputera')}
      <div class="chips">${[1, 2, 3, 4, 5, 6, 7, 8].map((l) => `<button class="chip ${f.level === l ? 'sel' : ''}" data-action="level" data-id="${l}">${l}</button>`).join('')}</div>
    </div>` : '';
  const color = f.mode !== 'seek' ? `
    <div class="field">${t('Kolor')}
      <div class="chips">${[['random', 'Losowo'], ['white', 'Białe'], ['black', 'Czarne']].map(([k, l]) => `<button class="chip ${f.color === k ? 'sel' : ''}" data-action="color" data-id="${k}">${t(l)}</button>`).join('')}</div>
    </div>` : '';
  // rankingowa tylko, gdy oboje mają konto (w poczekalni ogólnej zawsze)
  const ratedBlock = ratedBlockReason();
  const rated = f.mode !== 'ai' ? `
    <label class="toggle ${ratedBlock ? 'disabled' : ''}"><input type="checkbox" data-action="rated" ${f.rated && !ratedBlock ? 'checked' : ''} ${ratedBlock ? 'disabled' : ''}> ${t('Partia rankingowa')}</label>
    ${ratedBlock ? `<p class="muted small">${esc(ratedBlock)}</p>` : f.rated ? '' : `<p class="muted small">${t('Towarzyska: bez rankingu. W ustawieniach możesz włączyć „Tryb nauki” z podpowiedziami.')}</p>`}` : '';
  const lichessSeek = S.provider?.name === 'lichess' && f.mode === 'seek';
  const near = lichessSeek ? `
    <label class="toggle"><input type="checkbox" data-action="near" ${f.near ? 'checked' : ''}> ${t('Tylko rywale ±100 od mojego rankingu')}</label>
    <p class="muted small">${t('Ustaw bierki przed szukaniem — Lichess przerywa partię, gdy pierwszy ruch nie pada szybko.')}</p>` : '';
  const label = f.mode === 'seek' ? 'Szukaj rywala' : f.mode === 'friend' || f.mode === 'member' ? 'Wyślij wyzwanie' : 'Zagraj z komputerem';

  return `
  <section class="card">
    <h2>${t('Nowa partia')}</h2>
    <div class="tabs">${modes.map(([k, l]) => `<button class="tab ${f.mode === k ? 'sel' : ''}" data-action="mode" data-id="${k}">${t(l)}</button>`).join('')}</div>
    ${friend}
    ${member}
    ${seekList}
    ${presetsHtml}
    ${level}
    ${color}
    ${near}
    ${rated}
    <button class="btn primary big" data-action="start-game">${t(label)}</button>
  </section>`;
}

// Lobby Lichess: krótka informacja o własnych klubach i rankingu (gdy serwer klubów jest włączony).
function viewBanner() {
  if (!roomsEnabled() || savedAccount()) return '';
  return `<p class="note small">${t('Własne kluby, znajomi i ranking bez konta Lichess:')} <button class="link small" data-action="to-menu">${t('Menu')}</button> ${t('→ „Załóż konto”.')}</p>`;
}

function viewGame() {
  const G = S.game;
  if (!G.full) {
    return `<main class="game"><header class="g-top"><button class="btn small" data-action="back">${t('← Partie')}</button></header>
      <p class="muted center-text">${G.error ? esc(G.error) : t('Wczytywanie partii…')}</p></main>`;
  }
  const opp = G.myColor === 'white' ? G.full.black : G.full.white;
  const me = G.myColor === 'white' ? G.full.white : G.full.black;
  const tc = G.full.clock ? `${G.full.clock.initial / 60000}+${G.full.clock.increment / 1000}` : G.full.daysPerTurn ? `${G.full.daysPerTurn} d/ruch` : '';
  const meta = `${speedPl(G.full.speed)} ${tc}${G.full.rated ? ' · ' + t('rankingowa') : ''}`;
  const over = gameOver(G);

  // ostatni ruch rywala (trener: ostatni ruch w ogóle)
  const spec = !!G.spectator;
  let lastOpp = null;
  for (let i = G.history.length - 1; i >= 0; i--) { if (spec || G.history[i].color !== G.myColor[0]) { lastOpp = { m: G.history[i], idx: i }; break; } }
  const lastBlock = lastOpp
    ? `<div class="lm-label">${spec ? t('Ostatni ruch') : t('Ruch rywala')} · ${Math.floor(lastOpp.idx / 2) + 1}.${lastOpp.m.color === 'b' ? '..' : ''}</div>
       <div class="lm-san">${esc(fmtSan(lastOpp.m.san))}</div>
       <div class="lm-desc">${esc(describeMove(lastOpp.m))}</div>
       <button class="link small" data-action="repeat">${t('Powtórz na głos')}</button>`
    : `<div class="lm-label">${t('Ruch rywala')}</div>
       <div class="lm-san dim">—</div>
       <div class="lm-desc">${G.myColor === 'white' ? t('Zaczynasz białymi.') : t('Rywal gra białymi — czekaj na pierwszy ruch.')}</div>`;

  let status;
  if (over) status = '';
  else if (spec) status = `<div class="status">${t('Podgląd trenera · ruch')} ${G.chess?.turn() === 'w' ? t('białych') : 'czarnych'}</div>`;
  else if (myTurn(G)) status = `<div class="status on">${t('Twój ruch')}</div>`;
  else status = `<div class="status">${t('Ruch rywala — czekaj')}</div>`;

  const oppDraw = !spec && G.state && !over && (G.myColor === 'white' ? G.state.bdraw : G.state.wdraw);
  const myDraw = !spec && G.state && !over && (G.myColor === 'white' ? G.state.wdraw : G.state.bdraw);
  const notices = [];
  if (!G.conn) notices.push(`<div class="notice">${t('Brak połączenia — łączę ponownie…')}</div>`);
  if (oppDraw) notices.push(`<div class="notice">${t('Rywal proponuje remis.')} <span class="row-actions"><button class="btn small primary" data-action="draw-yes">${t('Przyjmij')}</button><button class="btn small" data-action="draw-no">${t('Odrzuć')}</button></span></div>`);
  if (myDraw) notices.push(`<div class="notice muted">${t('Zaproponowałeś remis.')}</div>`);
  const canTakeback = !spec && !!S.provider?.takeback;
  const oppTb = canTakeback && G.state && !over && (G.myColor === 'white' ? G.state.btakeback : G.state.wtakeback);
  const myTb = canTakeback && G.state && !over && (G.myColor === 'white' ? G.state.wtakeback : G.state.btakeback);
  if (oppTb) notices.push(`<div class="notice">${t('Rywal prosi o cofnięcie swojego ostatniego ruchu.')} <span class="row-actions"><button class="btn small primary" data-action="takeback-yes">${t('Zgódź się')}</button><button class="btn small" data-action="takeback-no">${t('Odmów')}</button></span></div>`);
  if (myTb) notices.push(`<div class="notice muted">${t('Poprosiłeś o cofnięcie ruchu — czekam na zgodę rywala.')} <button class="btn small" data-action="takeback-cancel">${t('Wycofaj prośbę')}</button></div>`);
  if (G.opponentGone && !over && !spec) {
    // wyraźny pasek z odliczaniem na żywo (updateClocks); przyciski aktywne po odliczaniu
    const left = goneLeft(G);
    notices.push(`<div class="gone-bar" role="alert">
      <div class="gone-title">${t('Rywal opuścił partię')}</div>
      <div class="gone-sub" id="gone-sub">${left > 0 ? `${t('Ogłosisz wygraną albo remis za')} <b id="gone-count">${fmtCountdown(left)}</b>${t(', jeśli nie wróci.')}` : t('Możesz ogłosić wygraną albo remis.')}</div>
      <div class="row-actions"><button class="btn small primary" data-action="claim-win" ${left > 0 ? 'disabled' : ''}>${t('Ogłoś wygraną')}</button>
        <button class="btn small" data-action="claim-draw" ${left > 0 ? 'disabled' : ''}>${t('Ogłoś remis')}</button></div>
    </div>`);
  }

  const myMoves = G.history.filter((m) => m.color === G.myColor[0]).length;
  const actions = over || spec ? '' : `
    <div class="g-actions">
      ${canTakeback && myMoves > 0 && !myTb && (G.state?.takebackLeft?.[G.myColor] ?? 1) > 0 ? `<button class="btn small" data-action="takeback-ask">${t('Cofnij mój ruch')}</button>` : ''}
      ${myDraw ? '' : `<button class="btn small" data-action="offer-draw" ${G.history.length < 2 ? 'disabled' : ''}>${t('Zaproponuj remis')}</button>`}
      ${myMoves === 0 ? `<button class="btn small" data-action="abort">${t('Przerwij')}</button>` : `<button class="btn small danger" data-action="resign">${t('Poddaj')}</button>`}
    </div>`;

  return `
  <main class="game">
    <header class="g-top">
      <button class="btn small" data-action="back">${t('← Partie')}</button>
      <div class="g-meta">${esc(meta)}</div>
      <button class="icon-btn" data-action="game-menu" aria-label="${t('Menu')}">⋯</button>
    </header>

    <div class="player">
      <span class="pname">${esc(playerLabel(opp))} <span class="muted">· ${G.myColor === 'white' ? 'czarne' : t('białe')}</span></span>
      <span class="clock" id="clock-opp"></span>
    </div>

    <section class="lastmove">${lastBlock}</section>

    ${notices.join('')}

    <div class="player me">
      <span class="pname">${spec ? esc(playerLabel(me)) : 'Ty'} <span class="muted">· ${G.myColor === 'white' ? t('białe') : 'czarne'}</span></span>
      <span class="clock" id="clock-me"></span>
    </div>
    ${status}

    <section id="entry">${over ? viewResult(G) : spec ? `<div class="spectate">${boardHtml()}</div>` : viewEntry()}</section>

    ${actions}
    ${viewChat(G)}

    ${viewHistory(G)}
  </main>`;
}

// Czat Lichess: ostatnia wiadomość rywala i gotowe odpowiedzi jednym kliknięciem.
const QUICK_REPLIES = ['Powodzenia!', 'Dzięki za grę!', 'Gram na prawdziwej szachownicy — ruch zajmuje mi chwilę.'];
function viewChat(G) {
  if (!S.provider?.chat || G.spectator) return '';
  return `
    <div class="chat-row">
      ${G.lastChat ? `<div class="small"><span class="muted">${esc(G.lastChat.user)}:</span> ${esc(G.lastChat.text)}</div>` : ''}
      <div class="chips">${QUICK_REPLIES.map((q, i) => `<button class="chip small" data-action="chat-send" data-id="${i}">${esc(t(q))}</button>`).join('')}</div>
    </div>`;
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
    if (S.entryErr) cls += ' err';
  } else if (r.state === 'typed') {
    line = `<span class="muted small">${t('Gotowe? Naciśnij „Wyślij ruch”.')}</span>`;
  } else if (r.state === 'ok') {
    line = `<span><strong>${esc(fmtSan(r.move.san))}</strong> — ${esc(describeMove(r.move))}</span>`;
  } else if (r.state === 'partial') {
    line = `<span class="muted small">${t('Pasuje:')} ${esc(r.hints.slice(0, 10).map(fmtSan).join(', '))}${r.hints.length > 10 ? '…' : ''}</span>`;
  } else if (r.state === 'ambiguous' || r.state === 'promo') {
    line = esc(r.msg); cls += ' warn';
  } else if (r.state === 'bad') {
    line = esc(r.msg); cls += ' err';
  } else {
    line = `<span class="muted small">${G.history.length < 2 && myTurn(G)
      ? t('Zagraj na szachownicy i zapisz ruch, np. e4 albo Nf3.')
      : t('Figura + pole (Nf3), pion: pole (e4) lub bicie (exd5). Roszada: O-O.')}</span>`;
  }
  const on = enabled ? '' : 'disabled';
  const key = (k, label, extra = '') => `<button class="key ${extra}" data-action="san" data-k="${k}" ${on}>${label}</button>`;
  const pieceKeys = SAN_PIECES.map(([en, name, pl]) => key(en, `${englishLetters() ? en : pl}<span class="key-sub">${t(name)}</span>`, 'piece')).join('');
  const fileKeys = FILES.map((f) => key(f, f)).join('');
  const rankKeys = RANKS.map((n) => key(n, n)).join('');
  const sub = (s) => `<span class="key-sub">${t(s)}</span>`;
  const extra = [['x', 'x' + sub('bicie')], ['=', '=' + sub('promocja')], ['O-O', 'O-O' + sub('krótka')], ['O-O-O', 'O-O-O' + sub('długa')]]
    .map(([k, l]) => key(k, l, 'piece')).join('');
  return `
    <div class="san-box ${S.san ? '' : 'empty'}" aria-live="polite">${S.san ? esc(fmtSan(S.san)) : t('np. e4, Nf3, exd5, O-O')}</div>
    <div class="${cls}" aria-live="polite">${line}</div>
    <div class="keys keys5">${pieceKeys}</div>
    <div class="keys">${fileKeys}</div>
    <div class="keys">${rankKeys}</div>
    <div class="keys keys4">${extra}</div>
    <div class="entry-actions">
      <button class="btn" data-action="backspace" ${S.san.length && !S.sending ? '' : 'disabled'}>${t('⌫ Cofnij')}</button>
      <button class="btn primary" data-action="send" ${enabled && (hints ? r.state === 'ok' : S.san.length > 0) ? '' : 'disabled'}>${t('Wyślij ruch')}</button>
    </div>
    <div class="entry-mode"><button class="link small" data-action="entry-mode">${t('Wpisujesz notacją · przełącz na „skąd → dokąd”')}</button>${hints ? ` · <span class="muted small">${t('tryb nauki')}</span>` : ''}</div>`;
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
      <div class="small">${t('Promocja piona na:')}</div>
      <div class="chips">${PROMO_PIECES.map((p) => `<button class="chip big" data-action="promo" data-id="${p.key}">${englishLetters() ? p.key.toUpperCase() : p.label} <span class="muted small">${t(p.name)}</span></button>`).join('')}</div>
    </div>` : '';
  const msgClass = S.entryErr ? 'entry-msg err' : 'entry-msg';
  const hint = G.history.length < 2 && myTurn(G) && !S.entryMsg
    ? t('Zagraj na szachownicy i wpisz ruch: pole startowe, potem docelowe (np. e2 e4).')
    : t('Roszada: wpisz ruch króla, np. e1 g1.');
  return `
    <div class="slots" aria-live="polite">${slots}</div>
    <div class="${msgClass}" aria-live="polite">${esc(S.entryMsg) || `<span class="muted small">${hint}</span>`}</div>
    ${promo}
    <div class="keys">${fileKeys}</div>
    <div class="keys">${rankKeys}</div>
    <div class="entry-actions">
      <button class="btn" data-action="backspace" ${S.input.length && !S.sending ? '' : 'disabled'}>${t('⌫ Cofnij')}</button>
      <button class="btn primary" data-action="send" ${enabled && S.input.length === 4 && !S.promo ? '' : 'disabled'}>${t('Wyślij ruch')}</button>
    </div>
    <div class="entry-mode"><button class="link small" data-action="entry-mode">${t('Wpisujesz „skąd → dokąd” · przełącz na notację (np. Nf3)')}</button></div>`;
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
  if (!rr.counted) return `<div class="muted small">${t('Ranking bez zmian:')} ${esc(t(UNRATED_PL[rr.reason] || 'partia się nie liczyła'))}.</div>`;
  const d = G.myColor === 'white' ? rr.diffW : rr.diffB;
  const now = S.provider?.me?.ratings?.[G.full.speed === 'classical' ? 'classical' : 'rapid']?.rating;
  return `<div class="rating-change">${t('Ranking:')} <b>${d > 0 ? '+' : ''}${d ?? 0}</b>${now ? ` → ${now}` : ''}</div>`;
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
      ${offer ? `<div class="notice rematch-note">${esc(offer.from)} ${t('proponuje rewanż')}</div>` : ''}
      <div class="stack">
        ${G.spectator ? '' : `<button class="btn primary ${offer ? 'pulse' : ''}" data-action="rematch">${offer ? t('Rewanż — odpowiedz') : t('Rewanż')}</button>`}
        <button class="btn ${G.spectator ? 'primary' : ''}" data-action="back">${G.spectator ? t('Wróć do panelu trenera') : t('Wróć do listy partii')}</button>
        ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${t('Analiza partii na Lichess')}</a>` : ''}
        ${!url && S.provider.gamePgn ? `<button class="btn" data-action="game-analysis" data-id="${esc(G.id)}">${t('Analiza partii na Lichess')}</button>
          <button class="link small" data-action="game-pgn" data-id="${esc(G.id)}">${t('Pobierz zapis partii (PGN)')}</button>` : ''}
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
    const color = offer.color === 'white' ? t('białymi') : offer.color === 'black' ? t('czarnymi') : t('losowym kolorem');
    S.modal = {
      kind: 'confirm', title: t('Przyjąć rewanż?'),
      text: t('{from} proponuje rewanż: {label}{v}. Grasz {color}.', { from: offer.from, label: offer.label, v: offer.rated ? ', rankingowa' : ', towarzyska', color: color }),
      okLabel: t('Tak, gramy'), cancelLabel: t('Nie'),
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
  opts.rematchOf = G.id; // Lichess: prawdziwy rewanż (u rywala zwykły przycisk „Rewanż”)
  closeGame();
  S.view = 'lobby';
  S.waiting = { text: t('Wysyłanie propozycji rewanżu…'), kind: 'pending' };
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
      S.waiting = null; toast(t('Rewanż wysłany do {name}. Partia pojawi się na liście po przyjęciu.', { name: opp.name }), 6000); render(); return;
    }
    waitFor(h, t('Czekam, aż {name} przyjmie rewanż', { name: opp.name }));
  } catch (e) {
    S.waiting = null; toast(e.message || t('Nie udało się wysłać rewanżu.')); render();
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
    S.coachReqs = d.requests?.length || 0;
    if (!S.roomHistory) S.roomHistory = await S.provider.history();
  } catch (e) { S.coach = { loading: false, error: e.message }; }
  if (S.view === 'coach') render();
}

// Panel: prośby o dołączenie, dodawanie po nicku, zaproszenia, zablokowani.
function viewMembership(d, myRole) {
  const day = (t) => new Date(t).toLocaleDateString('pl-PL');
  const btn = (action, id, label, cls = '') => `<button class="btn small ${cls}" data-action="${action}" data-id="${esc(id)}">${t(label)}</button>`;
  const row = (nick, sub, actions) => `<li class="friend-row"><span class="friend-nick">${esc(nick)}${sub ? ` <span class="muted small">${sub}</span>` : ''}</span><span class="row-actions">${actions}</span></li>`;
  const reqs = d.requests || [];
  return `
  <section class="card friends" id="membership">
    <h2>${t('Członkostwo')}</h2>
    ${myRole === 'owner'
    ? `<label class="toggle"><input type="checkbox" data-action="approval" ${d.approve ? 'checked' : ''}>
        <span>${t('Nowi członkowie wymagają zatwierdzenia')}<br><span class="muted small">${t('Kod i hasło klubu pozwalają tylko poprosić o dołączenie; wpuszczasz Ty albo admin.')}</span></span></label>`
    : `<p class="muted small">${t('Zatwierdzanie nowych członków:')} ${d.approve ? t('włączone') : t('wyłączone')} ${t('(zmienia założyciel).')}</p>`}
    <h3>${t('Prośby o dołączenie')}${reqs.length ? ` (${reqs.length})` : ''}</h3>
    ${reqs.length ? `<ul class="friend-list">${reqs.map((r) => row(r.nick,
    `${day(r.at)}${r.wasRemoved ? ` · <span class="warn">${t('wcześniej usunięty')}</span>` : ''}${r.rejected ? ' · ' + t('odrzucona {n}×', { n: r.rejected }) : ''}`,
    btn('req-approve', r.id, 'Przyjmij', 'primary') + btn('req-reject', r.id, 'Odrzuć'))).join('')}</ul>`
    : `<p class="muted small">${t('Brak oczekujących próśb. Prośba wygasa po 7 dniach.')}</p>`}
    <h3>${t('Dodaj do klubu po nicku')}</h3>
    <form data-form="invite-nick" class="inline-form" autocomplete="off">
      <input id="invite-nick" type="text" maxlength="20" autocapitalize="off" spellcheck="false" placeholder="${t('Nick konta')}" aria-label="${t('Nick konta do zaproszenia')}">
      <button type="submit" class="btn small">${t('Zaproś')}</button>
    </form>
    <p class="muted small">${t('Zaproszony wchodzi jednym kliknięciem w „Moich klubach”, bez kodu. Zaproszenie zdejmuje blokadę.')}</p>
    ${d.invites?.length ? `<ul class="friend-list">${d.invites.map((i) => row(i.nick, `zaproszony ${day(i.at)}`, btn('invite-cancel', i.id, 'Anuluj'))).join('')}</ul>` : ''}
    <h3>${t('Zablokowani w klubie')}</h3>
    ${d.blocked?.length ? `<ul class="friend-list">${d.blocked.map((b) => row(b.nick, b.reason === 'removed' ? t('usunięty z klubu') : t('prośby odrzucone 2×'),btn('member-unblock', b.id, 'Odblokuj'))).join('')}</ul>`
    : `<p class="muted small">${t('Nikt nie jest zablokowany.')}</p>`}
  </section>`;
}

function viewCoach() {
  const c = S.coach || {};
  const d = c.data;
  const ago = (t) => (t ? new Date(t).toLocaleDateString('pl-PL') : '—');
  const ongoing = d?.ongoing?.length
    ? d.ongoing.map((g) => `
      <button class="row" data-action="coach-watch" data-id="${esc(g.id)}">
        <span class="row-main">${esc(g.white)} – ${esc(g.black)}</span>
        <span class="row-sub">${esc(speedPl(g.speed))} ${esc(g.label)} · ${g.plies} ${t('półruchów')}${g.rated ? '' : ' ' + t('· towarzyska') + ''}</span>
        <span class="pill">${t('Podgląd')}</span>
      </button>`).join('')
    : `<p class="muted small">${t('Nikt teraz nie gra.')}</p>`;
  const myRole = S.provider.me?.role;
  const meId = S.user?.id;
  const ROLE_PL = { owner: 'założyciel', admin: 'admin' };
  // założyciel: mianuje adminów i usuwa; admin: usuwa zwykłych członków
  const manage = (m) => {
    if (m.id === meId || m.role === 'owner') return '';
    const b = [];
    if (myRole === 'owner') b.push(`<button class="link small" data-action="member-role" data-id="${esc(m.id)}" data-role="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? t('odbierz admina') : t('zrób adminem')}</button>`);
    if (myRole === 'owner' || m.role !== 'admin') b.push(`<button class="link small danger-text" data-action="member-remove" data-id="${esc(m.id)}" data-nick="${esc(m.nick)}">${t('usuń')}</button>`);
    return b.join(' · ');
  };
  const players = d ? `
    <div class="scroll"><table class="coach-table">
      <tr><th>${t('Gracz')}</th><th>${t('Partie')}</th><th>W</th><th>R</th><th>P</th><th>${t('Ostatnia')}</th><th></th></tr>
      ${d.members.map((m) => `<tr><td><span class="dot ${m.online ? 'on' : 'off'}"></span>${esc(m.nick)}${ROLE_PL[m.role] ? ` <span class="muted small">(${t(ROLE_PL[m.role])})</span>` : ''}</td>
        <td>${m.games}</td><td>${m.wins}</td><td>${m.draws}</td><td>${m.losses}</td><td>${ago(m.last)}</td><td class="nowrap">${manage(m)}</td></tr>`).join('')}
    </table></div>
    <p class="muted small">${t('W — wygrane, R — remisy, P — przegrane. Liczą się zakończone partie (rankingowe i towarzyskie).')}
      ${myRole === 'owner' ? t('Admin może przeglądać partie i usuwać członków.') : ''} ${t('Usunięta osoba nie wróci do klubu, dopóki jej nie odblokujesz (lista „Zablokowani w klubie”).')}</p>` : '';
  const hist = (S.roomHistory || []).filter((g) => g.status !== 'aborted' && g.status !== 'noStart');
  const games = hist.length ? `<ul class="hist-list">${hist.map((g) => `
      <li>
        <span class="hist-players">${esc(g.white)} – ${esc(g.black)}</span>
        <span class="hist-res">${RESULT_PL[g.winner] || '½–½'}</span>
        <span class="muted small">${esc(g.label)} · ${g.plies} ${t('półruchów ·')} ${new Date(g.endedAt).toLocaleDateString('pl-PL')}
          · <button class="link small" data-action="game-analysis" data-id="${esc(g.id)}">analiza</button>
          · <button class="link small" data-action="game-pgn" data-id="${esc(g.id)}">PGN</button></span>
      </li>`).join('')}</ul>` : `<p class="muted small">${t('Jeszcze nie rozegrano żadnej partii.')}</p>`;
  return `
  <main class="lobby">
    <header class="g-top"><button class="btn small" data-action="coach-close">${t('← Klub')}</button>
      <div class="g-meta">${t('Panel trenera ·')} ${esc(S.provider.roomName)}</div>
      <button class="icon-btn" data-action="coach-refresh" aria-label="${t('Odśwież')}">↻</button></header>
    ${c.error ? `<p class="error">${esc(c.error)}</p>` : ''}
    ${c.loading && !d ? '<p class="muted">Wczytywanie…</p>' : ''}
    <section class="card"><h2>${t('Trwające partie')}</h2>${ongoing}
      <p class="muted small">${t('Podgląd na żywo: ruchy, zegary i pozycja. Gracze nie widzą, że oglądasz.')}</p></section>
    ${d ? viewMembership(d, myRole) : ''}
    <section class="card"><h2>${t('Gracze')}</h2>${players}</section>
    <section class="card"><h2>${t('Rozegrane partie')}</h2>${games}
      ${hist.length ? `<button class="btn small" data-action="room-pgn">${t('Pobierz wszystkie partie (PGN)')}</button>` : ''}</section>
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
      <summary>${t('Zapis partii (')}${G.history.length} ${t('pół­ruchów)')}</summary>
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
      ${S.waiting.cancel ? `<button class="btn" data-action="cancel-wait">${t('Anuluj')}</button>` : ''}
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
          <button type="button" class="btn" data-action="modal-close">${t('Anuluj')}</button>
          <button type="submit" class="btn primary">${esc(m.okLabel || 'Zapisz')}</button>
        </div>
      </form>`;
  } else if (m.kind === 'settings') {
    const tog = (key, label, sub) => `
      <label class="toggle"><input type="checkbox" data-action="setting" data-key="${key}" ${S.settings[key] ? 'checked' : ''}>
        <span>${t(label)}${sub ? `<br><span class="muted small">${t(sub)}</span>` : ''}</span></label>`;
    body = `
      <h2>${t('Ustawienia')}</h2>
      ${tog('speech', 'Czytaj ruch rywala na głos', 'Po polsku, jeśli urządzenie ma polski głos.')}
      ${tog('sound', 'Krótki dźwięk przy ruchu rywala')}
      ${tog('vibrate', 'Wibracja przy ruchu rywala', 'Działa na Androidzie.')}
      ${tog('sanEntry', 'Wpisuję ruch notacją (np. Nf3, exd5, O-O)', 'Oficjalny zapis turniejowy. Wyłączone = pole startowe i docelowe (e2 e4).')}
      ${tog('englishNotation', 'Angielskie litery figur: K Q R B N', 'Jak na turniejach i w Lichess. Wyłączone = polskie: K H W G S (ruch rywala, zapis partii, przyciski).')}
      ${tog('autoSend', 'Wysyłaj ruch od razu po wpisaniu', 'Bez przycisku „Wyślij”. Szybciej, ale łatwiej o pomyłkę.')}
      ${tog('emergencyBoard', 'Awaryjny podgląd pozycji w menu partii', 'Na wypadek pomyłki przy przestawianiu bierek.')}
      ${tog('learnMode', 'Tryb nauki: podpowiedzi przy wpisywaniu ruchu', 'Tylko w partiach towarzyskich: pokazuje pasujące ruchy i opis. W rankingowych podpowiedzi nie ma nigdy.')}
      ${S.provider?.chat ? tog('readChat', 'Czytaj na głos wiadomości rywala (czat Lichess)') : ''}
      <div class="row-actions end"><button class="btn primary" data-action="modal-close">${t('Gotowe')}</button></div>`;
  } else if (m.kind === 'game-menu') {
    body = `
      <h2>${t('Partia')}</h2>
      <div class="stack">
        ${S.settings.emergencyBoard ? `<button class="btn" data-action="show-board">${t('Awaryjny podgląd pozycji')}</button>` : ''}
        <a class="btn" href="szachownica.html" target="_blank" rel="noopener">${t('Szachownica testowa (nowa karta)')}</a>
        <button class="btn" data-action="settings">${t('Ustawienia')}</button>
        <button class="btn" data-action="modal-close">${t('Zamknij')}</button>
      </div>`;
  } else if (m.kind === 'board') {
    body = `<h2>${t('Pozycja w partii')}</h2><p class="muted small">${t('Sprawdź i popraw ustawienie bierek na swojej szachownicy.')}</p>${boardHtml()}
      <div class="row-actions end"><button class="btn primary" data-action="modal-close">${t('Zamknij')}</button></div>`;
  } else if (m.kind === 'token') {
    const url = S.provider?.tokenCreateUrl?.() || new LichessProvider().tokenCreateUrl();
    body = `
      <h2>${t('Logowanie tokenem')}</h2>
      <p class="small">${t('Przydaje się, gdy zwykłe logowanie nie wraca do aplikacji (np. na iPhonie po dodaniu do ekranu głównego).')}</p>
      <ol class="small">
        <li><a href="${esc(url)}" target="_blank" rel="noopener">${t('Utwórz token na Lichess')}</a> ${t('(uprawnienie „Play games with the board API” jest już zaznaczone).')}</li>
        <li>${t('Skopiuj token i wklej go poniżej.')}</li>
      </ol>
      <label class="field">${t('Token')}
        <input id="token-input" type="password" autocomplete="off" spellcheck="false" placeholder="${t('lip_…')}">
      </label>
      <div class="row-actions end">
        <button class="btn" data-action="modal-close">${t('Anuluj')}</button>
        <button class="btn primary" data-action="token-save">${t('Zaloguj')}</button>
      </div>`;
  } else if (m.kind === 'room') {
    const p = S.provider;
    const link = p.inviteLink();
    const me = p.me || {};
    const room = p.room || {};
    const owner = me.role === 'owner';
    const accountPart = p.isPublic
      ? `<p class="small">${t('Konto:')} <strong>${esc(S.user?.name || '')}</strong>${me.hasPassword ? ' ' + t('· zabezpieczone hasłem') + '' : ` · <span class="warn">${t('bez hasła')}</span>`}${me.email ? `<br><span class="muted">${t('E-mail:')} ${esc(me.email)}</span>` : ''}</p>
         ${me.hasPassword ? '' : `<p class="note small">${t('Bez hasła konto i ranking są tylko na tym urządzeniu. Ustaw hasło, żeby logować się na każdym urządzeniu.')}</p>`}
         <div class="row-actions"><button class="btn small ${me.hasPassword ? '' : 'primary'}" data-action="secure-open">${me.hasPassword ? t('Zmień hasło lub e-mail') : t('Ustaw hasło')}</button></div>`
      : `<p class="small">${t('Kod klubu — podaj go osobom, z którymi chcesz grać:')}</p>
      <div class="club-code" id="club-code-show">${esc(p.roomCode)}</div>
      <input class="link-box" id="invite-link" type="text" readonly value="${esc(link || '')}" aria-label="${t('Link do klubu')}">
      <div class="row-actions">
        <button class="btn small primary" data-action="share-invite">${t('Udostępnij link')}</button>
        <button class="btn small" data-action="copy-code">${t('Kopiuj kod')}</button>
      </div>
      <p class="muted small">${t('Kod i link otwierają klub każdemu, kto je ma — wysyłaj tylko swoim.')}${room.hasPassword ? ' ' + t('Do dołączenia potrzebne jest też hasło klubu.') + '' : ''}</p>
      ${owner ? `<h3>${t('Dostęp do klubu')}</h3>
        <div class="row-actions">
          <button class="btn small" data-action="club-recode">${t('Zmień kod')}</button>
          <button class="btn small" data-action="club-password">${room.hasPassword ? t('Zmień lub usuń hasło klubu') : t('Ustaw hasło klubu')}</button>
        </div>
        <p class="muted small">${t('Po zmianie kodu stary kod i link przestają działać; obecni członkowie zostają.')}</p>` : ''}
      <p class="small">${t('Nowi członkowie:')} <strong>${room.approve ? t('czekają na zatwierdzenie') : t('wchodzą od razu po kodzie')}</strong>${me.role === 'owner' || me.role === 'admin' ? ` · <button class="link small" data-action="coach-open">${t('prośby i zaproszenia w panelu trenera')}</button>` : ''}.</p>`;
    const forget = p.isPublic
      ? (me.hasPassword
        ? `<button class="btn small" data-action="account-logout">${t('Wyloguj z tego urządzenia')}</button>`
        : `<button class="btn small danger" data-action="room-forget">${t('Usuń konto z tego urządzenia')}</button>`)
      : `${owner ? '' : `<button class="btn small danger" data-action="club-leave">${t('Opuść klub')}</button>`}
         <button class="btn small" data-action="room-forget">${t('Usuń z tego urządzenia')}</button>`;
    const devices = p.isPublic ? `
      <h3>${t(PASSKEY_NAME)}</h3>
      ${me.passkeys ? `<p class="small">${tn(me.passkeys, 'Włączone ({n} klucz).|Włączone ({n} klucze).|Włączone ({n} kluczy).')} ${t('Logujesz się jednym dotknięciem; hasło zostaje jako zapas.')}</p>
        <div class="row-actions">${passkeySupported() ? `<button class="btn small" data-action="passkey-add">${t('Dodaj na tym urządzeniu')}</button>` : ''}<button class="btn small" data-action="passkeys-remove">${t('Usuń klucze')}</button></div>`
    : passkeySupported() ? `<p class="small">${t('Logowanie Face ID, odciskiem palca albo PIN-em urządzenia — bez wpisywania hasła.')}</p>
        <div class="row-actions"><button class="btn small primary" data-action="passkey-add">${t('Włącz na tym urządzeniu')}</button></div>`
      : `<p class="muted small">${t('Ta przeglądarka nie obsługuje kluczy dostępu.')}</p>`}
      <h3>${t('Inne urządzenia')}</h3>
      <p class="small">${t('Na innym urządzeniu zaloguj się nickiem i hasłem — kluby i ranking wrócą same. Na komputerze możesz też kliknąć „Zaloguj telefonem” i zeskanować kod tutaj.')}</p>
      <div class="row-actions"><button class="btn small" data-action="qr-scan">${t('📷 Zaloguj komputer')}</button>
        <button class="btn small" data-action="logout-all">${t('Wyloguj wszystkie urządzenia')}</button></div>
      <h3>${t('Usunięcie konta')}</h3>
      <p class="small">${t('Usuwa konto i wszystkie Twoje dane. Rozegrane partie zostaną u rywali z nickiem „usunięty gracz”.')}</p>
      <div class="row-actions"><button class="btn small danger" data-action="delete-account">${t('Usuń konto…')}</button></div>`
      : `<h3>${t('Inne urządzenie')}</h3><p class="small">${t('Zaloguj się tam na swoje konto — klub będzie w „Moich klubach”.')}</p>`;
    body = `
      <h2>${p.isPublic ? t('Twoje konto') : t('Klub „{roomName}”', { roomName: esc(p.roomName) })}</h2>
      ${accountPart}
      ${devices}
      <div class="row-actions end">
        ${forget}
        <button class="btn primary" data-action="modal-close">${t('Gotowe')}</button>
      </div>`;
  } else if (m.kind === 'delete-account') {
    const clubs = m.clubs || [];
    body = m.loading ? `<h2>${t('Usuń konto')}</h2><p class="muted">${t('Wczytywanie…')}</p>` : `
      <h2>${t('Usunąć konto')} ${esc(S.user?.name || '')}?</h2>
      <p class="small">${t('Usuniemy od razu: nick, hasło, e-mail, klucze Face ID, logowania na wszystkich urządzeniach, znajomych, blokady, ranking i członkostwo w klubach. Rozegrane partie zostaną u rywali i w klubach z nickiem „usunięty gracz”. Z kopii zapasowych serwera dane znikną w ciągu 30 dni. Tego nie da się cofnąć.')}</p>
      ${clubs.length ? `<h3>${t('Twoje kluby')}</h3><p class="small">${t('Jesteś założycielem — zdecyduj, co z każdym klubem:')}</p>
        ${clubs.map((c) => `<label class="field">${esc(c.name)}
          <select id="del-club-${esc(c.room)}">
            <option value="">${t('— wybierz —')}</option>
            <option value="delete">${t('Usuń klub całkowicie (wszyscy członkowie go stracą)')}</option>
            ${c.members.map((x) => `<option value="${esc(x.id)}">${t('Przekaż:')} ${esc(x.nick)}${x.role === 'admin' ? ' (admin)' : ''}</option>`).join('')}
          </select></label>`).join('')}` : ''}
      <form data-form="delete-account" autocomplete="off">
        <label class="field">${t('Hasło (potwierdzenie)')}<input id="del-pass" type="password" autocomplete="current-password"></label>
        <div class="row-actions end">
          <button type="button" class="btn" data-action="modal-close">${t('Anuluj')}</button>
          <button type="submit" class="btn danger">${t('Usuń konto na zawsze')}</button>
        </div>
      </form>`;
  } else if (m.kind === 'qr-scan') {
    body = `
      <h2>${t('Zaloguj komputer')}</h2>
      <p class="small">${t('Na komputerze kliknij „Zaloguj telefonem” i skieruj aparat na kod QR.')}</p>
      ${S.scanError ? `<p class="note small">${esc(S.scanError)}</p>` : '<video id="qr-video" class="qr-video" playsinline muted></video>'}
      <form data-form="qr-code" class="inline-form" autocomplete="off">
        <input id="qr-code" type="text" maxlength="8" autocapitalize="characters" spellcheck="false" placeholder="${t('albo wpisz kod, np. K7M2QX')}" aria-label="${t('Kod z ekranu komputera')}">
        <button type="submit" class="btn small">${t('Dalej')}</button>
      </form>
      <div class="row-actions end"><button class="btn" data-action="qr-scan-close">${t('Zamknij')}</button></div>`;
  } else if (m.kind === 'secure') {
    const me = S.provider?.me || {};
    body = `
      <h2>${me.hasPassword ? t('Zmień hasło lub e-mail') : t('Zabezpiecz konto')}</h2>
      <p class="small">${t('Logujesz się nickiem')} <strong>${esc(S.user?.name || '')}</strong> ${t('i hasłem. Ranking zostaje.')}</p>
      <form data-form="secure" method="post" action="#">
      <input type="text" name="username" autocomplete="username" value="${esc(S.user?.name || '')}" hidden>
      ${me.hasPassword ? `<label class="field">${t('Obecne hasło')} <span class="muted">${t('(tylko przy zmianie hasła)')}</span><input id="sec-old" type="password" autocomplete="current-password"></label>` : ''}
      <label class="field">${me.hasPassword ? t('Nowe hasło (puste = bez zmiany)') : t('Hasło (min. 8 znaków)')}<input id="sec-pass" name="password" type="password" autocomplete="new-password"></label>
      <p class="muted small">${t('Użyj hasła, którego nie używasz nigdzie indziej.')} ${me.hasPassword ? t('Po zmianie hasła inne urządzenia zostaną wylogowane.') : ''}</p>
      <label class="field">E-mail <span class="muted">${t('(nieobowiązkowy — do odzyskania hasła)')}</span>
        <input id="sec-email" type="email" autocomplete="email" inputmode="email" value="${esc(me.email || '')}" placeholder="adres@e-mail.pl"></label>
      <div class="row-actions end">
        <button type="button" class="btn" data-action="modal-close">${t('Anuluj')}</button>
        <button type="submit" class="btn primary">${t('Zapisz')}</button>
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
  if (a === 'history-toggle' || a === 'room-history' || a === 'rated' || a === 'setting' || a === 'approval' || a === 'near') return; // obsługiwane przez 'change'/'toggle'
  switch (a) {
    case 'login':
      try { await new LichessProvider().login(); } catch (err) { S.startError = '' + t('Nie udało się rozpocząć logowania:') + ' ' + err.message; render(); }
      break;
    case 'token-login': S.modal = { kind: 'token' }; render(); break;
    case 'token-save': {
      const v = (document.getElementById('token-input')?.value || '').trim();
      if (!/^[A-Za-z0-9_]{10,}$/.test(v)) { toast(t('To nie wygląda na token Lichess.')); break; }
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
        title: t('Wylogować z Lichess?'), text: t('Aplikacja straci dostęp do Twojego konta Lichess na tym urządzeniu.'), okLabel: t('Wyloguj'),
        onOk: async () => { await new LichessProvider().logout(); render(); },
      });
      break;
    case 'logout':
      confirmModal({ title: t('Wylogować?'), text: S.provider?.isDemo ? t('Zakończysz tryb demo.') : t('Aplikacja straci dostęp do Twojego konta Lichess na tym urządzeniu.'), okLabel: t('Wyloguj'), onOk: logout });
      break;
    // --- wariant B: pokoje ---
    case 'room-new':
      S.startError = '';
      if (!savedAccount()) { openAccount('register', 'room-new'); break; } // klub zakłada się z kontem
      S.view = 'room-new'; render();
      break;
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
    case 'account-register': openAccount('register', 'start'); break;
    case 'qr-login': await startQrLogin(); break;
    case 'qr-cancel': stopQrLogin(); S.qr = null; S.view = 'start'; render(); break;
    case 'qr-scan': S.modal = null; await openQrScanner(); break;
    case 'qr-scan-close': closeScanner(); render(); break;
    case 'friend-link': await shareFriendLink(); break;
    case 'lang-open': S.langOpen = !S.langOpen; render(); break;
    case 'lang-set':
      S.langOpen = false;
      await setLang(id);
      pickVoice();
      render();
      break;
    case 'delete-account': await openDeleteAccount(); break;
    case 'passkey-login': await loginWithPasskey(); break;
    case 'passkey-add': await addPasskey(); break;
    case 'passkeys-remove':
      confirmModal({
        title: t('Usunąć klucze dostępu?'), text: t('Logowanie Face ID / odciskiem palca przestanie działać na wszystkich urządzeniach. Zostaje hasło.'),
        okLabel: t('Usuń'), danger: true,
        onOk: async () => { try { await S.provider.passkeysRemove(); toast(t('Usunięto klucze dostępu.')); render(); } catch (err) { toast(err.message); } },
      });
      break;
    case 'logout-all':
      confirmModal({
        title: t('Wylogować wszystkie urządzenia?'), text: t('Wszystkie inne telefony i komputery zostaną wylogowane z konta i klubów. To urządzenie zostaje zalogowane, a kluby otworzysz ponownie jednym kliknięciem.'),
        okLabel: t('Wyloguj wszystkie'), danger: true,
        onOk: async () => { try { await S.provider.logoutAll(); forgetAllClubs(); toast(t('Wylogowano wszystkie inne urządzenia.'), 5000); } catch (err) { toast(err.message); } },
      });
      break;
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
        title: t('Zablokować {v}?', { v: p?.nick || 'gracza' }), text: t('Nie będzie mógł Cię wyzwać ani zaprosić do znajomych. Zniknie z Twoich znajomych i ostatnich rywali. Nie dowie się o blokadzie.'),
        okLabel: t('Zablokuj'), danger: true, onOk: () => social(() => S.provider.block(id), 'Zablokowano.'),
      });
      break;
    }
    case 'friend-more': {
      const p = findPerson(id);
      confirmModal({
        title: p?.nick || t('Znajomy'), text: t('Usunąć z listy znajomych? Możesz też zablokować tę osobę.'),
        okLabel: t('Usuń ze znajomych'), danger: true, cancelLabel: t('Zablokuj'),
        onOk: () => social(() => S.provider.friendRemove(id), 'Usunięto ze znajomych.'),
        onCancel: () => social(() => S.provider.block(id), 'Zablokowano.'),
      });
      break;
    }
    // --- zarządzanie klubem ---
    case 'copy-code':
      try { await navigator.clipboard.writeText(S.provider.roomCode); toast(t('Skopiowano kod.')); } catch { toast(t('Skopiuj kod ręcznie.')); }
      break;
    case 'club-recode':
      confirmModal({
        title: t('Zmienić kod klubu?'), text: t('Stary kod i link przestaną działać. Obecni członkowie zostają w klubie.'), okLabel: t('Zmień kod'),
        onOk: async () => { try { const c = await S.provider.changeCode(); toast(t('Nowy kod: {c}', { c: c }), 5000); S.modal = { kind: 'room' }; render(); } catch (err) { toast(err.message); } },
      });
      break;
    case 'club-password':
      S.modal = {
        kind: 'prompt', title: t('Hasło klubu'), label: t('Nowe hasło (puste = bez hasła)'), type: 'password', autocomplete: 'new-password',
        text: t('Hasło klubu jest dodatkowym zabezpieczeniem oprócz kodu: dołączający musi znać jedno i drugie. Obecni członkowie nie muszą go wpisywać.'),
        onOk: async (v) => {
          try { const has = await S.provider.setRoomPassword(v); toast(has ? t('Ustawiono hasło klubu.') : t('Usunięto hasło klubu.')); S.modal = { kind: 'room' }; render(); } catch (err) { toast(err.message, 5000); }
        },
      };
      render();
      break;
    case 'club-leave':
      confirmModal({
        title: t('Opuścić klub?'), text: t('Znikniesz z listy członków. Ranking zostaje (jest wspólny). Wrócisz, dołączając ponownie kodem klubu.'),
        okLabel: t('Opuść klub'), danger: true,
        onOk: async () => { try { await S.provider.leaveRoom(); toast(t('Opuszczono klub.')); goMenu(); } catch (err) { toast(err.message); } },
      });
      break;
    case 'req-approve':
      try { await S.provider.approveRequest(id); toast(t('Przyjęto do klubu.')); await loadCoach(); } catch (err) { toast(err.message, 5000); }
      break;
    case 'req-reject':
      try { await S.provider.rejectRequest(id); toast(t('Odrzucono prośbę.')); await loadCoach(); } catch (err) { toast(err.message, 5000); }
      break;
    case 'member-unblock':
      try { await S.provider.unblockMember(id); toast(t('Odblokowano. Może znów poprosić o dołączenie.')); await loadCoach(); } catch (err) { toast(err.message, 5000); }
      break;
    case 'invite-cancel':
      try { await S.provider.cancelInvite(id); await loadCoach(); } catch (err) { toast(err.message, 5000); }
      break;
    case 'member-role':
      try { await S.provider.setRole(id, el.dataset.role); await loadCoach(); } catch (err) { toast(err.message); }
      break;
    case 'member-remove':
      confirmModal({
        title: t('Usunąć {nick} z klubu?', { nick: el.dataset.nick }), text: t('Ta osoba zostanie wylogowana z klubu i nie wróci, nawet znając kod — chyba że ją odblokujesz albo zaprosisz po nicku. Jej partie zostają w historii.'),
        okLabel: t('Usuń'), danger: true,
        onOk: async () => { try { await S.provider.removeMember(id); toast(t('Usunięto z klubu.')); await loadCoach(); } catch (err) { toast(err.message); } },
      });
      break;
    case 'account-logout':
      confirmModal({
        title: t('Wylogować z tego urządzenia?'), text: t('Zalogujesz się ponownie nickiem i hasłem. Ranking, znajomi i kluby zostają na koncie.'),
        okLabel: t('Wyloguj'), onOk: logout,
      });
      break;
    case 'seek-accept':
      unlockMedia();
      S.waiting = { text: t('Łączę z rywalem…'), kind: 'pending' }; render();
      try { await S.provider.seekAccept(id); } catch (err) { toast(err.message); }
      if (S.waiting?.kind === 'pending') { S.waiting = null; render(); }
      break;
    case 'room-menu': S.modal = { kind: 'room' }; render(); break;
    case 'share-invite': await shareLink(S.provider.inviteLink(), t('Klub „{name}” (kod {code}) — {app}', { name: S.provider.roomName, code: S.provider.roomCode, app: CONFIG.APP_NAME })); break;
    case 'room-forget':
      confirmModal({
        title: S.provider?.isPublic ? t('Usunąć konto z tego urządzenia?') : t('Usunąć klub z tego urządzenia?'),
        text: S.provider?.isPublic
          ? t('Wylogujesz się z tego urządzenia. Konto, ranking i kluby zostają — zalogujesz się ponownie nickiem i hasłem.')
          : t('Zostajesz członkiem klubu. Klub jest zapisany na koncie — otworzysz go ponownie z „Moich klubów”.'),
        okLabel: t('Usuń z urządzenia'), danger: true, onOk: logout,
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
    case 'coach-open': S.modal = null; S.view = 'coach'; await loadCoach(); break;
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
      resetEntry(); S.entryMsg = ''; S.entryErr = false;
      toast(sanEntry() ? t('Notacja: zapisz ruch, np. e4 albo Nf3.') : t('Skąd → dokąd: wpisz pole startowe i docelowe.'));
      renderEntry();
      break;
    case 'repeat': {
      const G = S.game;
      const last = [...(G?.history || [])].reverse().find((m) => m.color !== G.myColor[0]);
      if (last) say(moveKeys(last), '', true);
      break;
    }
    case 'offer-draw':
      try { await S.provider.draw(S.game.id, true); toast(t('Zaproponowano remis.')); } catch (err) { toast(err.message); }
      break;
    case 'draw-yes': try { await S.provider.draw(S.game.id, true); } catch (err) { toast(err.message); } break;
    case 'draw-no': try { await S.provider.draw(S.game.id, false); } catch (err) { toast(err.message); } break;
    case 'takeback-ask':
      confirmModal({
        title: t('Poprosić o cofnięcie ruchu?'),
        text: t('Rywal musi się zgodzić. Jeśli już odpowiedział, cofną się oba ruchy: jego i Twój. Czas na zegarze się nie zwraca.'),
        okLabel: t('Poproś'),
        onOk: async () => { try { await S.provider.takeback(S.game.id, true); toast(t('Poproszono o cofnięcie ruchu.')); } catch (err) { toast(err.message); } },
      });
      break;
    case 'takeback-yes': try { await S.provider.takeback(S.game.id, true); } catch (err) { toast(err.message); } break;
    case 'takeback-cancel': S.tbCancelled = true; // własne anulowanie — bez komunikatu „rywal odmówił”
    // fallthrough
    case 'takeback-no': try { await S.provider.takeback(S.game.id, false); } catch (err) { toast(err.message); } break;
    case 'resign':
      confirmModal({ title: t('Poddać partię?'), okLabel: t('Poddaj'), danger: true, onOk: async () => { try { await S.provider.resign(S.game.id); } catch (err) { toast(err.message); } } });
      break;
    case 'abort':
      confirmModal({ title: t('Przerwać partię?'), text: t('Przed pierwszym ruchem partia nie liczy się do rankingu.'), okLabel: t('Przerwij'), onOk: async () => { try { await S.provider.abort(S.game.id); } catch (err) { toast(err.message); } } });
      break;
    case 'claim-win': try { await S.provider.claimVictory(S.game.id); } catch (err) { toast(err.message); } break;
    case 'claim-draw': try { await S.provider.claimDraw(S.game.id); } catch (err) { toast(err.message); } break;
    case 'game-menu': S.modal = { kind: 'game-menu' }; render(); break;
    case 'chat-send': {
      const text = t(QUICK_REPLIES[Number(id)]);
      try { await S.provider.chat(S.game.id, text); toast(t('Wysłano: {text}', { text: text })); } catch (err) { toast(err.message); }
      break;
    }
    case 'show-board':
      confirmModal({
        title: t('Pokazać pozycję?'),
        text: t('To podgląd awaryjny — na wypadek, gdy bierki na Twojej szachownicy nie zgadzają się z partią.'),
        okLabel: t('Pokaż'),
        onOk: () => { S.modal = { kind: 'board' }; render(); },
      });
      break;
    default: break;
  }
});

app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.action === 'rated') { S.form.rated = el.checked; saveForm(); }
  if (el.dataset.action === 'near') { S.form.near = el.checked; saveForm(); }
  if (el.dataset.action === 'approval') {
    S.provider.setApproval(el.checked)
      .then((on) => { toast(on ? t('Nowi członkowie będą czekać na zatwierdzenie.') : t('Nowi członkowie wchodzą od razu po kodzie.')); loadCoach(); })
      .catch((err) => { toast(err.message); el.checked = !el.checked; });
  }
  if (el.dataset.action === 'setting') {
    S.settings[el.dataset.key] = el.checked; saveSettings();
    if (['sanEntry', 'englishNotation', 'learnMode'].includes(el.dataset.key)) { resetEntry(); S.entryMsg = ''; S.entryErr = false; }
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
    case 'friend-add': {
      const nick = (document.getElementById('friend-nick')?.value || '').trim();
      if (!nick) { toast(t('Wpisz nick gracza.')); break; }
      if (await social(() => S.provider.friendInvite(nick), t('Wysłano zaproszenie do {nick}.', { nick }))) {
        const i = document.getElementById('friend-nick'); if (i) i.value = '';
      }
      break;
    }
    case 'delete-account': await submitDeleteAccount(); break;
    case 'qr-code': {
      const code = (document.getElementById('qr-code')?.value || '').trim();
      if (code.length < 6) { toast(t('Kod ma 6 znaków — przepisz go z ekranu komputera.')); break; }
      closeScanner(); render();
      await qrConfirm(code);
      break;
    }
    case 'invite-nick': {
      const nick = (document.getElementById('invite-nick')?.value || '').trim();
      if (!nick) { toast(t('Wpisz nick konta.')); break; }
      try { const r = await S.provider.inviteNick(nick); toast(t('Zaproszono {nick}.', { nick: r.nick })); await loadCoach(); } catch (err) { toast(err.message, 5000); }
      break;
    }
    case 'prompt': { const m = S.modal; const v = document.getElementById('prompt-input')?.value || ''; S.modal = null; render(); if (m?.onOk) await m.onOk(v); break; }
    case 'secure': {
      const v = (k) => document.getElementById(k)?.value ?? '';
      const password = v('sec-pass');
      if (password && password.length < 8) { toast(t('Hasło musi mieć co najmniej 8 znaków.')); break; }
      const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
      try {
        await S.provider.setPassword({ password: password || undefined, oldPassword: v('sec-old') || undefined, email: v('sec-email').trim() });
        S.modal = null; toast(t('Zapisano. Możesz logować się nickiem i hasłem na każdym urządzeniu.'), 5000); render();
      } catch (err) { if (btn) btn.disabled = false; toast(err.message, 5000); }
      break;
    }
    default: break;
  }
});
// Akcja na liście znajomych: błąd jako komunikat, sukces opcjonalnym tekstem.
async function social(fn, okText) {
  try { await fn(); if (okText) toast(t(okText)); render(); return true; } catch (err) { toast(err.message, 5000); return false; }
}
app.addEventListener('input', (e) => {
  if (e.target.id === 'friend-input') { S.form.friend = e.target.value; saveForm(); }
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

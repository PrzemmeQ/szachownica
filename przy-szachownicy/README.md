# Przy Szachownicy

Grasz online na prawdziwej szachownicy. W aplikacji tylko wpisujesz swój ruch (przyciski a–h i 1–8 albo klawiatura Bluetooth), a ona pokazuje i czyta na głos ruch rywala. Partie, rywale i ranking są na koncie Lichess (Board API).

Działa w przeglądarce, a na Androidzie i iPhonie po dodaniu do ekranu głównego jak zwykła aplikacja (PWA). Nie potrzebuje własnego serwera.

Wszystkie pliki leżą w jednym folderze (bez podfolderów), żeby dało się je wgrać na GitHuba także z telefonu.

---

## 1. Wgranie na GitHub Pages (za darmo)

### Krok 0 – rozpakuj paczkę
- **Android:** aplikacja *Pliki* (Files by Google) → Pobrane → stuknij `przy-szachownicy.zip` → *Rozpakuj*.
- **iPhone:** aplikacja *Pliki* → stuknij plik zip → obok pojawi się folder.
- **Komputer:** prawy przycisk → *Wyodrębnij wszystkie*.

W folderze jest 17 plików, m.in. `index.html`, `app.js`, `config.js`.

### Krok 1 – konto i repozytorium
1. Wejdź na **github.com** i załóż konto (*Sign up*) albo się zaloguj.
2. Kliknij **+** w prawym górnym rogu → **New repository**.
3. *Repository name*: np. `szachownica`.
4. Zaznacz **Public** (na darmowym planie GitHub Pages działa tylko z publicznych repozytoriów).
5. Niczego więcej nie zaznaczaj → **Create repository**.

### Krok 2 – wgranie plików
1. Na stronie pustego repozytorium kliknij link **uploading an existing file**
   (albo przycisk **Add file → Upload files**).
2. Kliknij **choose your files** i zaznacz **wszystkie pliki** z rozpakowanego folderu naraz.
   - Na iPhonie: *Przeglądaj* → folder → *Wybierz* (u góry) → zaznacz wszystkie → *Otwórz*.
   - Na Androidzie: przytrzymaj pierwszy plik, potem stukaj kolejne (albo menu → *Zaznacz wszystko*).
   - Jeśli na telefonie nie widzisz przycisku wgrywania, włącz w przeglądarce *Wersja na komputer*.
3. Poczekaj, aż wszystkie pliki pojawią się na liście, i kliknij zielone **Commit changes**.

### Krok 3 – włączenie strony
1. W repozytorium wejdź w zakładkę **Settings** (na telefonie bywa schowana pod **⋯**).
2. W menu po lewej wybierz **Pages**.
3. W sekcji *Build and deployment*:
   - *Source*: **Deploy from a branch**
   - *Branch*: **main**, folder **/ (root)** → **Save**.
4. Odczekaj 1–3 minuty i odśwież stronę ustawień. U góry pojawi się:
   **Your site is live at `https://TWOJ-LOGIN.github.io/szachownica/`**.

To jest adres aplikacji. Otwórz go w telefonie.

### Krok 4 – na ekran główny telefonu
- **Android (Chrome):** menu **⋮** → **Zainstaluj aplikację** / **Dodaj do ekranu głównego**.
- **iPhone (Safari):** przycisk **Udostępnij** → **Do ekranu początkowego**.
  Jeśli po dodaniu do ekranu logowanie przez Lichess nie wraca do aplikacji, użyj **„Inny sposób: wklej token Lichess”**.

### Zmiana pliku później (np. `config.js`)
W repozytorium kliknij plik → ikona **ołówka** (*Edit*) → zmień → **Commit changes**. Strona odświeży się po ok. minucie.

---

## 2. Głosowanie 👍/👎 (Formularz Google)

Baner pyta: *„Grałbyś z rankingiem bez konta Lichess?”*. Kliknięcie 👍 lub 👎 wysyła głos do Twojego Formularza Google. Po 👍 można zostawić e-mail (nieobowiązkowo). Wysyłany jest też tryb: `lichess`, `demo` albo `niezalogowany`. Jedno urządzenie głosuje raz.

1. Wejdź na **forms.google.com** → **Pusty formularz**. Tytuł np. „Przy Szachownicy – głosy”.
2. Dodaj **3 pytania** typu **Krótka odpowiedź**, wszystkie **nieobowiązkowe**:
   `Głos`, `E-mail`, `Tryb`.
3. **Ustawienia → Odpowiedzi:** „Zbieraj adresy e-mail” = *Nie zbieraj*; „Ogranicz do 1 odpowiedzi” = **wyłączone**
   (inaczej formularz wymaga logowania do Google i głosy nie dotrą).
4. Jeśli w prawym górnym rogu jest przycisk **Opublikuj**, kliknij go.
5. Menu **⋮** → **Pobierz link do wstępnie wypełnionego formularza**.
   Wpisz dokładnie: w `Głos` → **GLOS**, w `E-mail` → **EMAIL**, w `Tryb` → **TRYB** → **Pobierz link** → **Kopiuj link**.
6. W GitHubie otwórz `config.js` → ołówek → wklej link między apostrofy:
   ```js
   FEEDBACK_FORM_LINK: 'https://docs.google.com/forms/d/e/…/viewform?usp=pp_url&entry.123=GLOS&entry.456=EMAIL&entry.789=TRYB',
   ```
   → **Commit changes**.
7. Test: otwórz aplikację (na komputerze można w oknie prywatnym), kliknij 👍. W formularzu zakładka **Odpowiedzi** pokaże głos i podsumowanie „tak / nie”. Przycisk *Połącz z Arkuszami* zrobi z tego arkusz.

Uwaga do interpretacji: 👍 to deklaracja, a nie zakup ani zobowiązanie. Pozostawiony e-mail jest mocniejszym sygnałem niż sama łapka.

---

## 3. Co umie aplikacja

- logowanie kontem Lichess (OAuth PKCE) albo tokenem,
- losowy rywal: rapid, klasyczne, korespondencja (blitz z losowym rywalem jest przez API Lichess zablokowany),
- wyzwanie znajomego po nicku i gra z komputerem Lichess (tu także blitz),
- partie rankingowe i bez rankingu (przełącznik „Partia rankingowa”),
- przyjmowanie i odrzucanie wyzwań, lista trwających partii,
- duży ostatni ruch rywala w polskiej notacji (K, H, W, G, S) + opis + czytanie na głos,
- zegary, propozycja remisu, poddanie, przerwanie, odebranie zwycięstwa po wyjściu rywala,
- sprawdzanie legalności ruchu przed wysłaniem, wybór figury przy promocji,
- awaryjny podgląd pozycji (w menu partii, z potwierdzeniem),
- tryb demo bez logowania (prosty komputer w przeglądarce, bez rankingu),
- głosowanie 👍/👎.

Klawiatura: litery a–h i cyfry 1–8, Enter = wyślij, Backspace = cofnij, Esc = wyczyść. Przy promocji: H, W, G, S.

## 4. Ustawienia w `config.js`

- `FEEDBACK_FORM_LINK` – link z formularza (sekcja 2).
- `CLIENT_ID` – identyfikator aplikacji dla Lichess; pusty = adres strony. Rejestracja aplikacji w Lichess nie jest potrzebna.
- `LICHESS_HOST` – `https://lichess.dev` do testów.
- `DEMO_ONLY` – tylko tryb demo.

## 5. Ograniczenia

- Gra z ludźmi wymaga konta Lichess: każde połączenie z Board API musi być zalogowane. Bez logowania jest tylko tryb demo z komputerem.
- Pomoc silnika jest zakazana zasadami fair play Lichess. Aplikacja jej nie zawiera.
- Brak powiadomień push o ruchu w partii korespondencyjnej (wersja 1).
- Czytanie na głos korzysta z syntezatora urządzenia. Jakość polskiego głosu zależy od telefonu.

## 6. Pliki

```
index.html, style.css, manifest.webmanifest, sw.js, ikony (icon*.png, icon.svg, apple-touch-icon.png)
app.js       – widoki i logika
lichess.js   – Lichess (OAuth, Board API, strumienie ND-JSON)
demo.js      – tryb demo
notation.js  – polska notacja, opisy, czytanie
ndjson.js    – czytanie strumieni
chess.js     – chess.js 1.4.0 (licencja BSD-2), zasady i legalność ruchów
config.js    – ustawienia
```

Źródło partii jest wymienne. Własny serwer (pokoje, własne Elo) wystarczy dopisać jako kolejny plik z tymi samymi metodami co `lichess.js`.

// Ustawienia aplikacji – jedyny plik, który trzeba edytować przed wdrożeniem.
export const CONFIG = {
  APP_NAME: 'Przy Szachownicy',

  // Adres Lichess (lichess.dev do testów).
  LICHESS_HOST: 'https://lichess.org',

  // Dowolny unikalny identyfikator aplikacji dla OAuth Lichess.
  // Pusty = adres strony (np. twojanazwa.github.io).
  CLIENT_ID: '',

  // Głosowanie 👍/👎 z banera trafia do Formularza Google (odpowiedzi widać w zakładce „Odpowiedzi”).
  // Wklej tu „link do wstępnie wypełnionego formularza”, w którym pola wypełniłeś słowami:
  // GLOS, EMAIL, TRYB (instrukcja w README). Pusty = głosowanie nie jest podpięte.
  FEEDBACK_FORM_LINK: '',

  // Adres serwera pokoi (wariant B, Cloudflare Workers), np. https://przy-szachownicy.twojanazwa.workers.dev
  // Pusty = przycisk „Graj w pokoju” jest ukryty.
  ROOMS_API: '',

  // true = tylko tryb demo (bez logowania), np. dla podglądu w miejscach, które blokują połączenia z lichess.org.
  DEMO_ONLY: false,
};

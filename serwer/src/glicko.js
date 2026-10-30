// Glicko-2 (Glickman 2012), jedna partia = jeden okres rankingowy — jak na Lichess.
const SCALE = 173.7178;
const TAU = 0.75;
const EPS = 0.000001;
// Start od 1200 (decyzja właściciela). Wzory Glicko-2 działają tak samo od dowolnego punktu startowego.
export const DEFAULT = { rating: 1200, rd: 350, vol: 0.06 };
const RD_MIN = 45;
const RD_MAX = 350;
export const PROVISIONAL_RD = 110;

function g(phi) { return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI)); }
function E(mu, muj, phij) { return 1 / (1 + Math.exp(-g(phij) * (mu - muj))); }

// p, o = { rating, rd, vol }, score = 1 | 0.5 | 0 z punktu widzenia p
function update(p, o, score) {
  const mu = (p.rating - 1500) / SCALE;
  const phi = p.rd / SCALE;
  const muj = (o.rating - 1500) / SCALE;
  const phij = o.rd / SCALE;
  const gj = g(phij);
  const ej = E(mu, muj, phij);
  const v = 1 / (gj * gj * ej * (1 - ej));
  const delta = v * gj * (score - ej);

  // nowa zmienność (algorytm Illinois)
  const a = Math.log(p.vol * p.vol);
  const f = (x) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPS; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gj * (score - ej);
  return {
    rating: muNew * SCALE + 1500,
    rd: Math.min(RD_MAX, Math.max(RD_MIN, phiNew * SCALE)),
    vol,
  };
}

// Zwraca nowe rankingi obu graczy. scoreW = 1 | 0.5 | 0
export function rateGame(white, black, scoreW) {
  return { white: update(white, black, scoreW), black: update(black, white, 1 - scoreW) };
}

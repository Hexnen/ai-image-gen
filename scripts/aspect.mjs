// Aspect-ratio helpers for the Resolution row of the config window (pure, no Foundry globals).

/** Ratios people recognise; the portrait forms are derived by swapping. */
const KNOWN = [[1, 1], [5, 4], [4, 3], [3, 2], [16, 10], [16, 9], [2, 1], [21, 9], [3, 1]];
/** Reduced ratios up to this size are shown exactly ("2:3", "16:9"); anything else is "≈". */
const EXACT_MAX = 32;
/** Max relative difference at which a size counts as "≈ a known ratio". */
const NEAR_TOL = 0.02;

export function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** Scale a ratio into a square box of `box` px, keeping proportions (landscape: full width). */
export function aspectBox(w, h, box = 56) {
  const long = Math.max(w, h);
  const pw = w >= h ? box : (box * w) / long;
  const ph = h > w ? box : (box * h) / long;
  return { pw: Math.round(pw * 10) / 10, ph: Math.round(ph * 10) / 10 };
}

/**
 * @returns {null | {w:number,h:number,rw:number,rh:number,exact:boolean,text:string,dec:number,decText:string,pw:number,ph:number}}
 *   `text` is "2:3" (exact) or "≈ 16:9" / "≈ 1.90:1" (approximate); `decText` is width/height to 2 places.
 */
export function aspectInfo(width, height, box = 56) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0) || !(h > 0)) return null;
  const g = gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  const dec = w / h;
  const base = { w, h, rw, rh, dec, decText: dec.toFixed(2), ...aspectBox(w, h, box) };
  if (rw <= EXACT_MAX && rh <= EXACT_MAX) return { ...base, exact: true, text: `${rw}:${rh}` };

  let best = null;
  for (const [a, b] of KNOWN) {
    for (const [kw, kh] of a === b ? [[a, b]] : [[a, b], [b, a]]) {
      const diff = Math.abs(dec - kw / kh) / (kw / kh);
      if (!best || diff < best.diff) best = { kw, kh, diff };
    }
  }
  if (best && best.diff <= NEAR_TOL) return { ...base, exact: false, text: `≈ ${best.kw}:${best.kh}` };
  return { ...base, exact: false, text: dec >= 1 ? `≈ ${dec.toFixed(2)}:1` : `≈ 1:${(1 / dec).toFixed(2)}` };
}

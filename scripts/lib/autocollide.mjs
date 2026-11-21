// Автоматична колізія зі стін, огорожі та стовпів — з форми й положення тайла. Один код для всіх будинків.
//
// Координати: t = y + x/2 (стала вздовж стіни осі L), s = y - x/2 (стала вздовж стіни осі R); x = t - s, y = (s + t)/2.
// Стіна — смуга ЗА лінією основи (відлік від камери: менша глибина), товщиною T. Гравець стоїть перед лінією,
// проходить лише там, де тайла немає (проріз завжди рівно такої ширини, як залишив малюнок карти).

const toScreen = (s, t) => [t - s, (s + t) / 2];

/** Прямокутник у (s, t) -> чотири кути на екрані. */
const rect = (s0, s1, t0, t1) => [toScreen(s0, t0), toScreen(s1, t0), toScreen(s1, t1), toScreen(s0, t1)];

/**
 * Смуги колізії для одного тайла стіни/огорожі.
 *   (gx, gy) — земля під тайлом; fw — ширина кадру; halves — [ліва, права] вісь нижнього краю (0/1/2) ПЕРЕД віддзеркаленням;
 *   flipX — розміщення віддзеркалене; T — товщина.
 */
export function wallBands(gx, gy, fw, halves, flipX, T) {
  let [a, b] = halves;
  if (flipX) { [a, b] = [b, a]; a = [0, 2, 1][a]; b = [0, 2, 1][b]; } // віддзеркалення міняє половини і осі місцями
  const s0 = gy - gx / 2, t0 = gy + gx / 2, hw = fw / 2; // сусідні тайли стоять через 32 px при ширині 40, тож смуги й так перекриваються
  const polys = [];
  const half = (axis, side) => {
    if (axis === 2) return side < 0 ? rect(s0 - T, s0, t0 - hw, t0) : rect(s0 - T, s0, t0, t0 + hw); // R: уздовж t
    return side < 0 ? rect(s0, s0 + hw, t0 - T, t0) : rect(s0 - hw, s0, t0 - T, t0); // L: уздовж s (ліворуч — униз, праворуч — угору)
  };
  if (a && a === b) {
    polys.push(a === 2 ? rect(s0 - T, s0, t0 - hw, t0 + hw) : rect(s0 - hw, s0 + hw, t0 - T, t0)); // пряма стіна — один прямокутник
  } else {
    if (a) polys.push(half(a, -1));
    if (b) polys.push(half(b, +1));
  }
  return polys;
}

/** Стовп: коло радіуса r на землі (на екрані — еліпс 2:1), 8 кутів. */
export function pillarPoly(gx, gy, r) {
  const pts = [];
  for (let k = 0; k < 8; k++) { const ang = (k / 8) * Math.PI * 2; pts.push([gx + Math.cos(ang) * r, gy + Math.sin(ang) * r * 0.5]); }
  return pts;
}

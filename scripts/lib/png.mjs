// Мінімальний декодер PNG (RGBA/GA, 8 біт, без interlace) + аналіз форми тайла. Без залежностей.
import zlib from "node:zlib";

/** Повертає { w, h, bpp, px } або null, якщо формат не підтримано. */
export function decodePng(buf) {
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 6 && ctype !== 4)) return null;
  const bpp = ctype === 6 ? 4 : 2, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0, b = y > 0 ? px[dst - stride + i] : 0, c = i >= bpp && y > 0 ? px[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + i] = v & 255;
    }
  }
  return { w, h, bpp, px };
}

/** Нахил лінійної регресії ys(xs). */
function slope(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

/**
 * Напрям ізометричної плоскої грані за ФОРМОЮ картинки (перший кадр): нахил верхнього і нижнього краю.
 * Ізометрична стіна — паралелограм з нахилом краю ±0,42…0,5 (2:1). Повертає:
 *   1 — вісь L (край іде вгору-праворуч, нахил < 0), 2 — вісь R (вгору-ліворуч, нахил > 0),
 *   0 — напрям невідомий (кут: край V-подібний; стовп; щось без нахилу).
 * Береться той край, нахил якого чіткіший (на нижньому краю буває цоколь); якщо краї мають протилежні знаки — це кут.
 */
export function axisFromPicture(png, frameW) {
  if (!png) return 0;
  const { w, h, bpp, px } = png, stride = w * bpp, fw = Math.min(frameW || w, w);
  const xs = [], top = [], bot = [];
  for (let x = 0; x < fw; x++) {
    let t = -1, b = -1;
    for (let y = 0; y < h; y++) if (px[y * stride + x * bpp + bpp - 1] >= 128) { if (t < 0) t = y; b = y; }
    if (t >= 0) { xs.push(x); top.push(t); bot.push(b); }
  }
  if (xs.length < 4) return 0;
  const st = slope(xs, top), sb = slope(xs, bot);
  const OK = (s) => Math.abs(s) >= 0.25 && Math.abs(s) <= 0.8;
  if (OK(st) && OK(sb) && Math.sign(st) !== Math.sign(sb)) return 0; // V-подібний край — кут
  const s = OK(st) && OK(sb) ? (Math.abs(st) >= Math.abs(sb) ? st : sb) : OK(st) ? st : OK(sb) ? sb : 0;
  return s === 0 ? 0 : s < 0 ? 1 : 2;
}

/**
 * Точка, де тайл ЛЯГАЄ НА ЗЕМЛЮ: центр нижнього краю видимої частини (перший кадр), у координатах картинки.
 * Для стіни — середина лінії основи, для вузької рамки/стовпа — їхній низ. Саме за нею рахується глибина
 * (редакторський якір у різних тайлів стоїть по-різному: у дверей — посередині, у балок — вгорі).
 */
export function groundPoint(png, frameW) {
  if (!png) return null;
  const { w, h, bpp, px } = png, stride = w * bpp, fw = Math.min(frameW || w, w), c = Math.floor(fw / 2);
  const bottomOf = (x) => { for (let y = h - 1; y >= 0; y--) if (px[y * stride + x * bpp + bpp - 1] >= 128) return y + 1; return -1; };
  const near = [];
  for (let x = Math.max(0, c - 2); x <= Math.min(fw - 1, c + 2); x++) { const b = bottomOf(x); if (b >= 0) near.push(b); }
  let by = near.length ? near.reduce((a, b) => a + b, 0) / near.length : -1;
  if (by < 0) for (let x = 0; x < fw; x++) by = Math.max(by, bottomOf(x)); // центр порожній — найнижча точка
  return by < 0 ? null : { bx: fw / 2, by };
}

/** Нахил за медіаною нахилів між парами точок (Тейл-Сен): один "викид" не псує результат. */
function medianSlope(xs, ys) {
  const all = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 4; j < xs.length; j++) all.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  if (!all.length) return 0;
  all.sort((a, b) => a - b);
  return all[Math.floor(all.length / 2)];
}

/**
 * Напрям лівої і правої ПОЛОВИНИ нижнього краю тайла: [ліва, права], кожна 0/1(L)/2(R).
 * Пряма стіна — обидві половини однакові; ЗОВНІШНІЙ кут (V-подібний низ) і ВНУТРІШНІЙ (Λ-подібний) — різні.
 * З цього збірка будує колізію кутів без жодних налаштувань.
 */
export function bottomHalfAxes(png, frameW) {
  if (!png) return [0, 0];
  const { w, h, bpp, px } = png, stride = w * bpp, fw = Math.min(frameW || w, w), c = Math.floor(fw / 2);
  const xs = [], bot = [];
  for (let x = 0; x < fw; x++) {
    let b = -1;
    for (let y = h - 1; y >= 0; y--) if (px[y * stride + x * bpp + bpp - 1] >= 128) { b = y; break; }
    if (b >= 0) { xs.push(x); bot.push(b); }
  }
  const half = (lo, hi) => {
    const X = [], Y = [];
    xs.forEach((x, i) => { if (x >= lo && x < hi) { X.push(x); Y.push(bot[i]); } });
    if (X.length < 3) return 0;
    const s = medianSlope(X, Y); // стійкий до випадкових стовпців на краю картинки
    return Math.abs(s) >= 0.25 && Math.abs(s) <= 0.8 ? (s < 0 ? 1 : 2) : 0;
  };
  return [half(0, c), half(c, fw)];
}

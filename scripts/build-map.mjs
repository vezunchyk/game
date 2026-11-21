// ============================================================================
// scripts/build-map.mjs
// Перетворює експорт TileWeaver (.json) на два файли:
//   data/server-map.json        — для СЕРВЕРА: межі, колізії, спавни (кілька КБ)
//   public/assets/map.json      — для КЛІЄНТА: що і де малювати
//   public/assets/tiles/*.png   — картинки тайлів (замість base64 у json)
// Запуск:  npm run build-map -- шлях/до/tileweaver_Map.json
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, axisFromPicture, groundPoint, bottomHalfAxes } from "./lib/png.mjs";
import { wallBands, pillarPoly } from "./lib/autocollide.mjs";
import { classifyTile } from "./lib/folder-kinds.mjs";

const src = process.argv[2];
if (!src) {
  console.error("Використання: npm run build-map -- <tileweaver.json>");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(src, "utf8"));

const OUT_TILES = "public/assets/tiles";
fs.mkdirSync("data", { recursive: true });
// Файли пишемо ЛИШЕ в кінці й лише якщо перевірки пройшли — щоб помилка в карті не лишила гру з порожніми картинками.
const pngOut = [];

/** Читає ширину/висоту PNG з його заголовка (без бібліотек). */
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// --- Правила позиціювання ПЕРЕНЕСЕНІ З РЕДАКТОРА (index.html, placementBBox) ---------------
// Якір тайла = (p.x, p.y) + зсув gridAnchor/edgeAnchorT (точка на ребрі ромба клітинки).
// Лівий верхній кут = якір - розмір * pivot. Pivot за замовчуванням — ЦЕНТР (0.5, 0.5).
const CELL = raw.cellSize || 64;
function diamondVertices() {
  if (raw.gridType === "isoAsym") {
    const k = CELL / 64;
    return [{ x: 0, y: -16 * k }, { x: 30 * k, y: -1 * k }, { x: -2 * k, y: 15 * k }, { x: -32 * k, y: 0 }];
  }
  if (raw.gridType === "iso" || raw.gridType === "isoPixel") {
    const hw = CELL / 2, hh = CELL / 4;
    return [{ x: 0, y: -hh }, { x: hw, y: 0 }, { x: 0, y: hh }, { x: -hw, y: 0 }];
  }
  return [{ x: 0, y: -CELL / 2 }, { x: CELL / 2, y: 0 }, { x: 0, y: CELL / 2 }, { x: -CELL / 2, y: 0 }];
}
function pointOnDiamond(t) {
  const v = diamondVertices();
  t = ((t % 1) + 1) % 1;
  const seg = t * 4, i0 = Math.floor(seg) % 4, i1 = (i0 + 1) % 4, f = seg - Math.floor(seg);
  const a = v[i0], b = v[i1];
  return { x: Math.round(a.x + (b.x - a.x) * f), y: Math.round(a.y + (b.y - a.y) * f) };
}
function gridAnchorOffset(t) {
  if (typeof t.edgeAnchorT === "number") return pointOnDiamond(t.edgeAnchorT);
  const names = { top: 0, right: 1, bottom: 2, left: 3 };
  if (t.gridAnchor && t.gridAnchor in names) {
    const v = diamondVertices()[names[t.gridAnchor]];
    return { x: Math.round(v.x), y: Math.round(v.y) };
  }
  return { x: 0, y: 0 };
}
function tilePivot(t) {
  if (t.pivotX != null && t.pivotY != null) return { x: t.pivotX, y: t.pivotY };
  if (t.anchor === "bottom") return { x: 0.5, y: 1 };
  return { x: 0.5, y: 0.5 };
}

// --- Види тайлів за папкою (map-src/folder-kinds.json) ------------------------------------
// Єдина таблиця "папка -> вид" для всіх будинків. Лежить у репозиторії, а не поряд з картою.
const kindsFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../map-src/folder-kinds.json");
const cfg = JSON.parse(fs.readFileSync(kindsFile, "utf8"));
const folderById = new Map((raw.tileFolders || []).map((f) => [f.id, f]));
const errors = [], warnings = [];
const AXIS_NAME = ["невідомо", "L", "R"];

// --- 1. Тайли, які реально використані на карті -----------------------------
const usedIds = new Set(raw.placements.map((p) => p.tileId));
const tiles = {};
for (const id of usedIds) {
  const t = raw.tiles[id];
  if (!t) continue;
  const buf = Buffer.from(t.dataURL.split(",")[1], "base64");
  pngOut.push([id, buf]);
  const { w, h } = pngSize(buf);
  const pv = tilePivot(t);
  const ga = gridAnchorOffset(t);
  if (Array.isArray(t.frames) && t.frames.length > 1) warnings.push(`тайл ${id} має кадри різної ширини (tile.frames) — гра їх не підтримує`);
  const frames = t.animFrames ? Number(t.animFrames) : 1;

  // Вид, "внутрішня" позначка, світло/темно — з папки.
  const info = classifyTile(t, folderById, cfg);
  const label = `${id} «${t.name ?? ""}» (${[...info.chain].reverse().join("/") || "без папки"})`;
  if (!info.kind) errors.push(`тайл ${label} використаний на карті, але його папки немає в map-src/folder-kinds.json`);

  // Напрям: ЗА КАРТИНКОЮ (основне) і за папкою Світлі/Темні (друге джерело).
  const png = decodePng(buf);
  const gp = groundPoint(png, w / frames) || { bx: w / frames / 2, by: h };
  const pic = axisFromPicture(png, w / frames);
  const byShade = info.shade ? cfg.axisByShade[info.shade] : 0;
  let axis = pic || byShade || 0;
  if (cfg.axisKinds.includes(info.kind)) {
    if (pic && byShade && pic !== byShade) {
      errors.push(`тайл ${label}: картинка має вісь ${AXIS_NAME[pic]}, а папка «${info.shade === "light" ? "Світлі" : "Темні"}» вимагає ${AXIS_NAME[byShade]} — тайл у не тій папці`);
    } else if (!axis && !info.axisless) {
      warnings.push(`тайл ${label}: не вдалося визначити вісь (і це не кут) — малюватиметься як кут`);
    }
  }
  // Заготовка під крок 2: ЄДИНА поведінка за видом. Поки клієнт розуміє лише старий міст (rule/tag).
  tiles[id] = {
    w, h, px: pv.x, py: pv.y, gx: ga.x, gy: ga.y,
    // анімація — горизонтальна стрічка кадрів; як у редакторі, крутиться лише з галочкою "Грати постійно"
    gbx: gp.bx, gby: gp.by,
    ha: bottomHalfAxes(png, w / frames),
    frames,
    frameMs: t.animFrameMs ? Number(t.animFrameMs) : 150,
    loop: t.animLoop ? 1 : 0,
    kind: info.kind,
    interior: info.interior ? 1 : 0,
    shade: info.shade,
    axis,
  };
}

// --- 2. Розміщення: одразу рахуємо ТОЧНО ТАК, як редактор ---------------------
// [tileId, x0, y0, z, sortKey, flags, ax, ay, pvx, pvy, axis]
//   axis      — напрям стіни ПІСЛЯ віддзеркалення: 1 = L (знизу-ліворуч угору-праворуч), 2 = R, 0 = невідомо
//   x0,y0     — лівий верхній кут (цілі, як Math.round у редакторі)
//   sortKey   — p.sortY ?? p.y (редактор сортує за (z, sortKey))
//   flags     — 1: flipX, 2: flipY, 4: isRoof, flags>>3: поверх тайла (floor)
//   ax,ay     — ЗЕМЛЯ під об'єктом: центр нижнього краю видимої частини картинки (за нею рахується глибина;
//               якір з редактора для цього не годиться: у дверей він посередині, у балок угорі). Балка успадковує
//               точку від найближчих дверей/рамки/стіни під нею.
//   pvx,pvy   — точка, навколо якої віддзеркалюється
const placements = [];
const warnedNoCollision = new Set();
// Підлога поверхів 2+ (плоскі тайли: плита, паркет): гравець на цьому поверсі може стояти лише на них (+ сходи).
// Ромб верхньої грані тайла: центр (x0 + w/2, y0 + 16.5), півширини w/2, піввисота 16.5.
const floorMask = [];
const autoPolys = []; // автоколізія: { id, floor, pts }
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const p of raw.placements) {
  const t = tiles[p.tileId];
  if (!t) continue;
  if ((p.scaleX ?? 1) !== 1 || (p.scaleY ?? 1) !== 1 || p.rotation || p.skewX) {
    console.warn(`УВАГА: ${p.id} має масштаб/поворот/нахил — гра це не підтримує`);
  }
  const fw = t.w / t.frames;
  const ax = p.x + t.gx, ay = p.y + t.gy;
  const x0 = Math.round(ax - fw * t.px), y0 = Math.round(ay - t.h * t.py);
  // flags: 1 flipX, 2 flipY, 4 isRoof, біти 3+ — поверх тайла (0 = не прив'язаний: земля/декор)
  const tFloor = Number.isFinite(p.floor) && p.floor >= 1 ? Math.min(15, Math.floor(p.floor)) : 0;
  const flags = (p.flipX ? 1 : 0) | (p.flipY ? 2 : 0) | (p.isRoof ? 4 : 0) | (tFloor << 3);
  if (tFloor >= 2 && !p.isRoof && t.kind === "floor") floorMask.push([tFloor, x0 + fw / 2, y0 + 16.5, fw / 2, 16.5]);
  const pvx = x0 + fw * t.px, pvy = y0 + t.h * t.py;
  let gx = x0 + t.gbx;
  const gy = y0 + t.gby;
  if (p.flipX) gx = 2 * pvx - gx; // віддзеркалення навколо pivot, як при малюванні
  // Автоколізія з виду тайла (стіни/огорожа — смуга за лінією основи, кути — з форми низу; стовпи — коло).
  const lvl = Math.max(1, tFloor);
  const cc = cfg.collision || {};
  if ((t.kind === "wall" || t.kind === "fence") && !p.isRoof) {
    if (!t.axis && !t.ha[0] && !t.ha[1]) warnedNoCollision.add(`${p.tileId} «${tiles[p.tileId]?.name ?? ""}»`);
    // Пряма стіна (вісь за картинкою відома) — суцільна смуга; кут (вісь 0) — дві смуги за формою низу.
    const halves = t.axis ? [t.axis, t.axis] : t.ha;
    wallBands(gx, gy, fw, halves, !!p.flipX, (cc[t.kind] || { thickness: 8 }).thickness).forEach((pts, i) =>
      autoPolys.push({ id: `auto:${p.id ?? p.tileId}:${i}`, floor: lvl, pts }));
  } else if (t.kind === "pillar") {
    autoPolys.push({ id: `auto:${p.id ?? p.tileId}`, floor: lvl, pts: pillarPoly(gx, gy, (cc.pillar || { radius: 5 }).radius) });
  }
  placements.push([p.tileId, x0, y0, p.z, p.sortY != null ? p.sortY : p.y, flags, gx, gy, pvx, pvy, (p.flipX ? 1 : 0) !== (p.flipY ? 1 : 0) ? [0, 2, 1][t.axis] : t.axis]);
  minX = Math.min(minX, x0); minY = Math.min(minY, y0);
  maxX = Math.max(maxX, x0 + fw); maxY = Math.max(maxY, y0 + t.h);
}

// Балка висить над проходом і до землі не торкається, тож її "земля" береться від того, що під нею:
// найближчих (по x) дверей, потім рамки дверей, потім стіни тієї ж осі.
for (const pl of placements) {
  if (tiles[pl[0]].kind !== "beam") continue;
  let best = null, bestScore = Infinity;
  for (const o of placements) {
    const k = tiles[o[0]].kind;
    const prio = k === "door" ? 0 : k === "door_frame" ? 1 : k === "wall" ? 2 : -1;
    if (prio < 0 || o[10] !== pl[10] || o[7] <= pl[7]) continue; // під балкою, тієї ж осі
    const dx = Math.abs(o[6] - pl[6]);
    if (dx > (prio === 2 ? 64 : 24)) continue; // двері/рамка — майже під балкою; стіна — може бути збоку від проходу
    const score = prio * 1000 + dx;
    if (score < bestScore) { bestScore = score; best = o; }
  }
  if (best) {
    // Балка висить рівно над своєю точкою на землі: та сама екранна x, а глибина — лінії носія (стіни/дверей).
    pl[7] = pl[10] === 2 ? (best[7] - best[6] / 2) + pl[6] / 2 : (best[7] + best[6] / 2) - pl[6] / 2;
  }
  else warnings.push(`балка в (${Math.round(pl[6])}, ${Math.round(pl[7])}) без дверей/стіни під нею — глибина за її власною точкою`);
}

// Рамка дверей без власного нахилу (вузька смужка): вісь береться з найближчої балки чи дверей поруч.
for (const pl of placements) {
  if (tiles[pl[0]].kind !== "door_frame" || pl[10]) continue;
  let best = null, bestD = 80;
  for (const o of placements) {
    if (!o[10] || !["beam", "door"].includes(tiles[o[0]].kind)) continue;
    const d = Math.hypot(o[6] - pl[6], o[7] - pl[7]);
    if (d < bestD) { bestD = d; best = o; }
  }
  if (best) pl[10] = best[10];
}

// --- 3. Межі світу: за розміщеними тайлами + відступ ------------------------
const PAD = 16;
const bounds = { minX: minX + PAD, minY: minY + PAD, maxX: maxX - PAD, maxY: maxY - PAD };

// --- 4. Колізії і спавни для сервера ----------------------------------------
// Поверх колізії: onFloor (1, 2, 3...); немає поля = поверх 1.
const floorOf = (c) => (Number.isFinite(c.onFloor) && c.onFloor >= 1 ? Math.floor(c.onFloor) : 1);
const collisions = raw.collisions
  .filter((c) => c.shape === "poly" && c.type === "solid")
  .map((c) => ({ id: c.id, floor: floorOf(c), pts: c.pts.map((q) => [q.x, q.y]) }));
collisions.push(...autoPolys);
// Зони зміни поверху. Два способи позначити в редакторі, гра розуміє обидва:
//   floorTransition: onFloor (де діє) + toFloor (куди переносить; fromFloor = onFloor);
//   trigger з полем floor: onFloor (де діє) + floor (куди переносить).
// Спрацьовує, коли гравець, що стоїть на поверсі onFloor, ВХОДИТЬ у зону ззовні.
const isNum = (v) => Number.isFinite(v);
const transitions = [];
for (const c of raw.collisions) {
  if (c.shape !== "poly") continue;
  let onFloor, toFloor;
  if (c.type === "floorTransition") {
    onFloor = isNum(c.fromFloor) ? c.fromFloor : isNum(c.onFloor) ? c.onFloor : 1;
    toFloor = isNum(c.toFloor) ? c.toFloor : onFloor + 1;
  } else if (c.type === "trigger" && isNum(c.floor)) {
    onFloor = isNum(c.onFloor) ? c.onFloor : 1;
    toFloor = c.floor;
  } else continue;
  transitions.push({ id: c.id, onFloor, toFloor, pts: c.pts.map((q) => [q.x, q.y]) });
}
// Сходи: зона "вгору" (onFloor < toFloor) і найближча до неї зона "вниз" на ті самі поверхи — це два КІНЦІ
// одних сходів. Поверх міняється на СЕРЕДИНІ сходів (див. server/game/Movement.ts), а не при вході в зону.
// Зони, яким не знайшлась пара, лишаються звичайними переходами (миттєва зміна поверху при вході).
const centroid = (pts) => [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length];
const stairs = [];
const pairedIds = new Set();
for (const up of transitions.filter((t) => t.toFloor > t.onFloor)) {
  let best = null, bestD = Infinity;
  for (const dn of transitions) {
    if (pairedIds.has(dn.id) || dn.onFloor !== up.toFloor || dn.toFloor !== up.onFloor) continue;
    const a = centroid(up.pts), c = centroid(dn.pts);
    const d = Math.hypot(a[0] - c[0], a[1] - c[1]);
    if (d < bestD) { bestD = d; best = dn; }
  }
  if (!best) continue;
  pairedIds.add(up.id); pairedIds.add(best.id);
  const a0 = centroid(up.pts), b0 = centroid(best.pts);
  // Кінець сходів зони c119 лежить на краю плити; рейку продовжуємо вздовж осі, поки не опинимось НА плиті верхнього поверху.
  const len = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1;
  const ex = (b0[0] - a0[0]) / len, ey = (b0[1] - a0[1]) / len;
  const onMask = (x, y) => floorMask.some(([f, cx, cy, hw, hh]) => f === up.toFloor && Math.abs(x - cx) / (hw + 8) + Math.abs(y - cy) / (hh + 4) <= 1);
  let top = b0;
  for (let k = 0; k <= 60; k++) { const q = [b0[0] + ex * k, b0[1] + ey * k]; if (onMask(q[0], q[1])) { top = [q[0] + ex * 2, q[1] + ey * 2]; break; } }
  stairs.push({ id: up.id + "+" + best.id, low: up.onFloor, high: up.toFloor, a: a0, b: b0, top });
}
const looseTransitions = transitions.filter((t) => !pairedIds.has(t.id));

const spawns = (raw.spawns || []).map((s) => ({ x: s.x, y: s.y }));

for (const n of warnedNoCollision) warnings.push(`тайл ${n}: не вдалося визначити форму низу — колізії не створено`);
// --- 5. Перевірки карти ----------------------------------------------------------------------
for (const t of transitions) if (!pairedIds.has(t.id)) warnings.push(`зона переходу ${t.id} (${t.onFloor}→${t.toFloor}) не має пари для сходів — працює як миттєвий перехід`);
for (const st of stairs) {
  if (st.top === st.b) warnings.push(`сходи ${st.id}: вгорі не знайдено плитки підлоги поверху ${st.high} — гравцю нікуди зійти`);
}
const kindOf = (pl) => tiles[pl[0]].kind;
const doors = placements.filter((pl) => kindOf(pl) === "door");
const frames = placements.filter((pl) => ["beam", "door_frame"].includes(kindOf(pl)));
for (const d of doors) {
  if (!frames.some((f) => Math.hypot(f[6] - d[6], f[7] - d[7]) < 80)) warnings.push(`двері в (${Math.round(d[6])}, ${Math.round(d[7])}) без рамки (Двері/Балки) поряд`);
}
const kindCounts = {};
for (const pl of placements) kindCounts[kindOf(pl) || "—"] = (kindCounts[kindOf(pl) || "—"] || 0) + 1;

console.log(`Автоколізій: ${autoPolys.length}`);
console.log("Види розміщень:", JSON.stringify(kindCounts));
if (warnings.length) console.log(`\nПОПЕРЕДЖЕННЯ (${warnings.length}):\n` + warnings.map((w) => "  - " + w).join("\n"));
if (errors.length) {
  console.error(`\nПОМИЛКИ (${errors.length}) — карту НЕ збудовано, старі файли гри не змінено:\n` + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

// --- 6. Запис файлів -------------------------------------------------------------------------
fs.rmSync(OUT_TILES, { recursive: true, force: true });
fs.mkdirSync(OUT_TILES, { recursive: true });
for (const [id, buf] of pngOut) fs.writeFileSync(path.join(OUT_TILES, `${id}.png`), buf);
fs.writeFileSync("data/server-map.json", JSON.stringify({ name: raw.name, bounds, collisions, transitions: looseTransitions, stairs, floorMask, spawns }));
fs.writeFileSync("public/assets/map.json", JSON.stringify({ format: 5, name: raw.name, bounds, tiles, placements }));

// Для режиму ?debug у клієнті (малює колізії поверх карти). Грі НЕ потрібен.
fs.writeFileSync("public/assets/debug-collisions.json", JSON.stringify(collisions.map((c) => c.pts)));

console.log(`Карта "${raw.name}": ${placements.length} тайлів, ${Object.keys(tiles).length} картинок, ${collisions.length} колізій (по поверхах: ${JSON.stringify(collisions.reduce((a, c) => ((a[c.floor] = (a[c.floor] || 0) + 1), a), {}))}), ${looseTransitions.length} переходів, ${stairs.length} сходів, ${floorMask.length} плиток підлоги поверхів 2+, ${spawns.length} спавнів`);
console.log("Межі:", bounds);

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

const src = process.argv[2];
if (!src) {
  console.error("Використання: npm run build-map -- <tileweaver.json>");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(src, "utf8"));

const OUT_TILES = "public/assets/tiles";
fs.rmSync(OUT_TILES, { recursive: true, force: true });
fs.mkdirSync(OUT_TILES, { recursive: true });
fs.mkdirSync("data", { recursive: true });

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

// --- Правила малювання за папкою тайла (map-src/render-rules.json, поряд із картою) ----------
// Папка тайла в редакторі (разом з усіма батьківськими) -> назва правила для клієнта.
const rulesFile = path.join(path.dirname(src), "render-rules.json");
const ruleList = fs.existsSync(rulesFile) ? JSON.parse(fs.readFileSync(rulesFile, "utf8")).rules || [] : [];
const folderById = new Map((raw.tileFolders || []).map((f) => [f.id, f]));
function folderNames(t) {
  const names = [];
  for (let id = t.folderId, n = 0; id && n < 32; n++) {
    const f = folderById.get(id);
    if (!f) break;
    names.push(f.name);
    id = f.parentId;
  }
  return names;
}
function ruleFor(t) {
  const names = folderNames(t);
  for (const r of ruleList) if (names.includes(r.folder)) return r.rule;
  return "";
}

// --- 1. Тайли, які реально використані на карті -----------------------------
const usedIds = new Set(raw.placements.map((p) => p.tileId));
const tiles = {};
for (const id of usedIds) {
  const t = raw.tiles[id];
  if (!t) continue;
  const buf = Buffer.from(t.dataURL.split(",")[1], "base64");
  fs.writeFileSync(path.join(OUT_TILES, `${id}.png`), buf);
  const { w, h } = pngSize(buf);
  const pv = tilePivot(t);
  const ga = gridAnchorOffset(t);
  if (Array.isArray(t.frames) && t.frames.length > 1) console.warn(`УВАГА: тайл ${id} має кадри різної ширини (tile.frames) — гра їх не підтримує`);
  tiles[id] = {
    w, h, px: pv.x, py: pv.y, gx: ga.x, gy: ga.y,
    // анімація — горизонтальна стрічка кадрів; як у редакторі, крутиться лише з галочкою "Грати постійно"
    frames: t.animFrames ? Number(t.animFrames) : 1,
    frameMs: t.animFrameMs ? Number(t.animFrameMs) : 150,
    loop: t.animLoop ? 1 : 0,
    rule: ruleFor(t),
  };
}

// --- 2. Розміщення: одразу рахуємо ТОЧНО ТАК, як редактор ---------------------
// [tileId, x0, y0, z, sortKey, flags, ax, ay, pvx, pvy, tag]
//   x0,y0     — лівий верхній кут (цілі, як Math.round у редакторі)
//   sortKey   — p.sortY ?? p.y (редактор сортує за (z, sortKey))
//   flags     — 1: flipX, 2: flipY, 4: isRoof, flags>>3: поверх тайла (floor)
//   ax,ay     — точка прив'язки (де об'єкт стоїть на землі)
//   pvx,pvy   — точка, навколо якої віддзеркалюється
//   tag       — тег тайла з редактора (напр. "Балка", "Сходи"); порожній рядок, якщо нема
const placements = [];
// Підлога поверхів 2+ (плоскі тайли: плита, паркет): гравець на цьому поверсі може стояти лише на них (+ сходи).
// Ромб верхньої грані тайла: центр (x0 + w/2, y0 + 16.5), півширини w/2, піввисота 16.5.
const floorMask = [];
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
  if (tFloor >= 2 && !p.isRoof && t.h < 40 && p.tag !== "Балка") floorMask.push([tFloor, x0 + fw / 2, y0 + 16.5, fw / 2, 16.5]);
  placements.push([p.tileId, x0, y0, p.z, p.sortY != null ? p.sortY : p.y, flags, ax, ay, x0 + fw * t.px, y0 + t.h * t.py, typeof p.tag === "string" ? p.tag : ""]);
  minX = Math.min(minX, x0); minY = Math.min(minY, y0);
  maxX = Math.max(maxX, x0 + fw); maxY = Math.max(maxY, y0 + t.h);
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

fs.writeFileSync("data/server-map.json", JSON.stringify({ name: raw.name, bounds, collisions, transitions: looseTransitions, stairs, floorMask, spawns }));
fs.writeFileSync("public/assets/map.json", JSON.stringify({ format: 3, name: raw.name, bounds, tiles, placements }));

// Для режиму ?debug у клієнті (малює колізії поверх карти). Грі НЕ потрібен.
fs.writeFileSync("public/assets/debug-collisions.json", JSON.stringify(collisions.map((c) => c.pts)));

const ruleCounts = {};
for (const t of Object.values(tiles)) if (t.rule) ruleCounts[t.rule] = (ruleCounts[t.rule] || 0) + 1;
console.log("Правила малювання (тайлів на правило):", JSON.stringify(ruleCounts));
const tagCounts = {};
for (const p of placements) if (p[10]) tagCounts[p[10]] = (tagCounts[p[10]] || 0) + 1;
console.log("Теги (тайлів на тег):", JSON.stringify(tagCounts));
console.log(`Карта "${raw.name}": ${placements.length} тайлів, ${Object.keys(tiles).length} картинок, ${collisions.length} колізій (по поверхах: ${JSON.stringify(collisions.reduce((a, c) => ((a[c.floor] = (a[c.floor] || 0) + 1), a), {}))}), ${looseTransitions.length} переходів, ${stairs.length} сходів, ${floorMask.length} плиток підлоги поверхів 2+, ${spawns.length} спавнів`);
console.log("Межі:", bounds);

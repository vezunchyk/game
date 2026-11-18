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
    loop: t.animLoop ? 1 : 0,
    // Без галочки "Грати постійно" кадр стоїть на місці (старий клієнт теж: період = майже вічність).
    frameMs: t.animLoop ? (t.animFrameMs ? Number(t.animFrameMs) : 150) : 3600000,
  };
}

// --- 2. Розміщення ----------------------------------------------------------
// ФОРМАТ 3 (сумісний зі старими клієнтами): [tileId, ax, ay, z, flipX, isRoof, flipY, sortKey]
//   ax, ay  — ТОЧКА ПРИВ'ЯЗКИ тайла на карті, з урахуванням зсуву по ребру ромба (edgeAnchorT) —
//             саме її редактор ставить у позицію pivot тайла;
//   лівий верхній кут = (ax, ay) - розмір * pivot(tile.px, tile.py)  — робить сам клієнт.
const placements = [];
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const p of raw.placements) {
  const t = tiles[p.tileId];
  if (!t) continue;
  if ((p.scaleX ?? 1) !== 1 || (p.scaleY ?? 1) !== 1 || p.rotation || p.skewX) {
    console.warn(`УВАГА: ${p.id} має масштаб/поворот/нахил — гра це не підтримує`);
  }
  const fw = t.w / t.frames;
  const ax = p.x + t.gx, ay = p.y + t.gy;
  placements.push([p.tileId, ax, ay, p.z, p.flipX ? 1 : 0, p.isRoof ? 1 : 0, p.flipY ? 1 : 0, p.sortY != null ? p.sortY : p.y]);
  const x0 = Math.round(ax - fw * t.px), y0 = Math.round(ay - t.h * t.py);
  minX = Math.min(minX, x0); minY = Math.min(minY, y0);
  maxX = Math.max(maxX, x0 + fw); maxY = Math.max(maxY, y0 + t.h);
}

// --- 3. Межі світу: за розміщеними тайлами + відступ ------------------------
const PAD = 16;
const bounds = { minX: minX + PAD, minY: minY + PAD, maxX: maxX - PAD, maxY: maxY - PAD };

// --- 4. Колізії і спавни для сервера ----------------------------------------
const collisions = raw.collisions
  .filter((c) => c.shape === "poly" && c.type === "solid")
  .map((c) => ({ id: c.id, pts: c.pts.map((q) => [q.x, q.y]) }));
const spawns = (raw.spawns || []).map((s) => ({ x: s.x, y: s.y }));

fs.writeFileSync("data/server-map.json", JSON.stringify({ name: raw.name, bounds, collisions, spawns }));
fs.writeFileSync("public/assets/map.json", JSON.stringify({ format: 3, name: raw.name, bounds, tiles, placements }));

// Для режиму ?debug у клієнті (малює колізії поверх карти). Грі НЕ потрібен.
fs.writeFileSync("public/assets/debug-collisions.json", JSON.stringify(collisions.map((c) => c.pts)));

console.log(`Карта "${raw.name}": ${placements.length} тайлів, ${Object.keys(tiles).length} картинок, ${collisions.length} колізій, ${spawns.length} спавнів`);
console.log("Межі:", bounds);

// Тест порядку малювання: одне правило глибини для стін, балок, поверхів і даху (без браузера, на підставному canvas).
import assert from "node:assert/strict";
import { MapRenderer, type MapFile } from "../client/render/MapRenderer.js";

type Img = HTMLImageElement;
const view = { left: -1000, top: -1000, right: 1000, bottom: 1000 };

/** Підставний canvas: записує, які тайли й у якому порядку намальовано (id картинки). */
function fakeCtx(log: string[]) {
  const ctx: any = {
    globalAlpha: 1,
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {}, scale() {},
    drawImage(img: any) { log.push(img.id + (ctx.globalAlpha < 1 ? "~" : "")); },
  };
  return ctx as CanvasRenderingContext2D;
}

/** Плитка: [id, вид, ширина, висота] -> TileInfo. */
const tile = (kind: string, w = 40, h = 84, interior = 0) => ({ kind, interior, w, h, px: 0.5, py: 1, frames: 1, frameMs: 150, loop: 0 });
/** Розміщення: [id, x0, y0, z, key, flags, ax, ay, pvx, pvy, axis]; якір = (ax, ay). */
const place = (id: string, ax: number, ay: number, o: { z?: number; floor?: number; roof?: boolean; axis?: number } = {}) =>
  [id, ax - 20, ay - 84, o.z ?? 10, ay, ((o.floor ?? 0) << 3) | (o.roof ? 4 : 0), ax, ay, ax, ay, o.axis ?? 0] as MapFile["placements"][number];

function make(tiles: MapFile["tiles"], placements: MapFile["placements"]): MapRenderer {
  const r = new MapRenderer();
  const imgs = new Map<string, Img>(Object.keys(tiles).map((id) => [id, { id } as unknown as Img]));
  r.build({ format: 5, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, tiles, placements }, imgs);
  return r;
}

/** Годинник тесту (мс): час тече лише вперед, як у грі. */
let clock = 1000;

/** Кадр: база -> персонаж ("P") -> перемальовка поверх нього -> верх. */
function frame(r: MapRenderer, px: number, py: number, o: { floor?: number; level?: number; viewerLevel?: number } = {}): string[] {
  const log: string[] = [];
  const ctx = fakeCtx(log);
  const floor = o.floor ?? 1, level = o.level ?? floor, viewerLevel = o.viewerLevel ?? level;
  r.drawBase(ctx, view, 0, floor, viewerLevel);
  log.push("P");
  r.drawOver(ctx, view, 0, { left: px - 26, top: py - 66, right: px + 26, bottom: py + 8 }, px, py, level, viewerLevel, floor);
  const warm = fakeCtx([]); // дати альфі даху вирости/зникнути (плавний перехід), у журнал це не йде
  for (let i = 0; i < 20; i++) r.drawUpper(warm, view, (clock += 200), px, py, floor, viewerLevel);
  r.drawUpper(ctx, view, (clock += 200), px, py, floor, viewerLevel);
  return log;
}
const after = (log: string[]) => log.slice(log.indexOf("P") + 1);

export function run(): void {
  const tiles = {
    gr: tile("floor", 64, 33), wallR: tile("wall"), wallL: tile("wall"), beam: tile("beam", 40, 60),
    roof: tile("roof", 64, 40), slab: tile("floor", 64, 37), pillar: tile("pillar", 16, 60), stairs: tile("stairs", 66, 97),
  };

  // 1. Стіна осі R (s = y - x/2): гравець ПЕРЕД нею — не перекриває; ЗА нею — стіна перемальовується поверх нього
  const r1 = make(tiles, [place("gr", 0, 0, { z: 1 }), place("wallR", 0, 0, { axis: 2 })]);
  assert.deepEqual(frame(r1, 0, 20), ["gr", "wallR", "P"], "перед стіною: нічого поверх");
  assert.deepEqual(frame(r1, 0, -30), ["gr", "wallR", "P", "wallR"], "за стіною: стіна над гравцем");
  // допуск: на 3 px «за лінією» — ще не перекриває (колізії пускають впритул)
  assert.deepEqual(after(frame(r1, 0, -3)), [], "допуск глибини біля лінії стіни");

  // 2. Сусідні сегменти ОДНІЄЇ стіни ведуть себе однаково (раніше ріжуло гравця збоку)
  const r2 = make(tiles, [place("wallR", -32, -16, { axis: 2 }), place("wallR", 0, 0, { axis: 2 }), place("wallR", 32, 16, { axis: 2 })]);
  const near = after(frame(r2, 0, 20)); // s_p = 20 > s_w(0) -> перед усіма трьома
  assert.deepEqual(near, [], "поруч із стіною, ПЕРЕД нею — жоден сегмент не накриває");
  assert.equal(after(frame(r2, 0, -30)).length, 3, "ЗА стіною — накривають усі три");

  // 3. Вісь L: глибина t = y + x/2
  const r3 = make(tiles, [place("wallL", 0, 0, { axis: 1 })]);
  assert.deepEqual(after(frame(r3, 0, 20)), []);
  assert.deepEqual(after(frame(r3, 0, -30)), ["wallL"]);

  // 4. Балка: гравець у прорізі під нею, навіть трохи ПЕРЕД лінією, — під балкою; далі від прорізу — звичайне правило
  const r4 = make(tiles, [place("beam", 0, 0, { axis: 2 })]);
  assert.deepEqual(after(frame(r4, 0, 10)), ["beam"], "у прорізі (10 px перед лінією) — під балкою");
  assert.deepEqual(after(frame(r4, 0, 40)), [], "далеко перед стіною — балка не чіпає");
  assert.deepEqual(after(frame(r4, 200, 0)), [], "поза довжиною балки — не чіпає");

  // 5. Кут/стовп без осі: перед гравцем лише коли ближчий за обома осями
  const r5 = make(tiles, [place("pillar", 0, 0)]);
  assert.deepEqual(after(frame(r5, 0, -30)), ["pillar"], "стовп прямо перед гравцем (ближче за обома осями)");
  assert.deepEqual(after(frame(r5, 0, 30)), []);
  assert.deepEqual(after(frame(r5, 60, -6)), [], "збоку (ближчий лише за однією віссю) — не накриває");

  // 6. Поверхи: плита 2-го поверху — НАД глядачем на 1-му (малюється після), а для глядача на 2-му — ПІД ним
  const r6 = make(tiles, [place("gr", 0, 0, { z: 1 }), place("slab", 0, -80, { floor: 2, z: 20 }), place("wallR", 0, 0, { floor: 1, axis: 2, z: 13 })]);
  assert.deepEqual(frame(r6, 0, 20, { floor: 1 }), ["gr", "wallR", "P", "slab"], "глядач на 1-му: плита поверху — ПІСЛЯ гравця (над ним)");
  const up = frame(r6, 0, -90, { floor: 2 });
  assert.deepEqual(up.slice(0, up.indexOf("P") + 1), ["gr", "wallR~", "slab", "P"], "глядач на 2-му: нижній поверх тьмяний, плита ПІД ним");
  // стіна 1-го поверху НЕ перекриває гравця на 2-му поверсі (нижчі об'єкти ніколи не перекривають вищих)
  assert.ok(!after(up).includes("wallR"), "нижчий поверх не перекриває вищий");

  // 7. Дах: над глядачем на 1-му — є; на поверсі 2+ — зникає
  const r7 = make(tiles, [place("roof", 0, -100, { roof: true, z: 40 }), place("wallR", 0, 0, { axis: 2 })]);
  assert.ok(frame(r7, 50, 200, { floor: 1 }).includes("roof"), "дах видно, коли глядач далеко");
  assert.ok(!frame(r7, 50, 200, { floor: 2 }).includes("roof"), "дах ховається на поверсі 2");

  // 8. Сходи — плоске (під гравцем) і не тьмяніють
  const r8 = make(tiles, [place("stairs", 0, 0, { floor: 1, z: 16 })]);
  const st = frame(r8, 0, -20, { floor: 2, level: 2, viewerLevel: 2 });
  assert.deepEqual(st, ["stairs", "P"], "сходи під гравцем, без затемнення");
  console.log("render: OK");
}

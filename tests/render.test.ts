// Тест порядку малювання нового ядра: групи -> (z, y) усередині групи -> персонаж за y ніг -> будинок і прозорість. Без браузера, на підставному canvas.
import assert from "node:assert/strict";
import { MapRenderer, type Actor, type MapFile, type Placement, type Viewer } from "../client/render/MapRenderer.js";

type Img = HTMLImageElement;
const view = { left: -1000, top: -1000, right: 1000, bottom: 1000 };

/** Підставний canvas: записує, які тайли й у якому порядку намальовано (id картинки; "~" — напівпрозорий). */
function fakeCtx(log: string[]) {
  const ctx: any = {
    globalAlpha: 1,
    save() {}, restore() {}, translate() {}, scale() {},
    drawImage(img: any) { log.push(img.id + (ctx.globalAlpha < 1 ? "~" : "")); },
  };
  return ctx as CanvasRenderingContext2D;
}

const tile = (o: { w?: number; h?: number } = {}) => ({ w: o.w ?? 40, h: o.h ?? 84, frames: 1, frameMs: 150, loop: 0 });
/** Групи: 0 = земля, 1 = поверх 1, 2 = поверх 2, 3 = дах. */
const groups = [{ floor: 0, roof: 0 }, { floor: 1, roof: 0 }, { floor: 2, roof: 0 }, { floor: 0, roof: 1 }];
const G = { ground: 0, f1: 1, f2: 2, roof: 3 };
/** Розміщення з точкою опори (ax, sy) у групі grp, у будинку house (-1 — без будинку). */
const place = (id: string, ax: number, sy: number, o: { z?: number; grp?: number; house?: number } = {}): Placement =>
  [id, ax - 20, sy - 84, o.z ?? 10, sy, 0, ax, sy, ax, sy, 0, ax, sy, o.grp ?? G.f1, o.house ?? -1];

/** Ромб підлоги 64x32 з центром (cx, cy) на поверсі f. */
const diamond = (f: number, cx: number, cy: number): [number, number, number, number, number] => [f, cx, cy, 32, 16];

function make(tiles: MapFile["tiles"], placements: Placement[], houses: MapFile["houses"] = []): MapRenderer {
  const r = new MapRenderer();
  const imgs = new Map<string, Img>(Object.keys(tiles).map((id) => [id, { id } as unknown as Img]));
  r.build({ format: 7, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, tiles, groups, houses, placements }, imgs);
  return r;
}

let clock = 1000; // годинник тесту (мс): час тече лише вперед, як у грі
/** Кадр: персонажі ("P", "Q") разом з картою. Перед кадром даємо прозорості дійти до цілі. */
function frame(r: MapRenderer, actors: { name: string; x: number; y: number; level?: number }[], v: Partial<Viewer> = {}): string[] {
  const me = actors[0]!;
  const viewer: Viewer = { x: me.x, y: me.y, floor: v.floor ?? 1, level: v.level ?? v.floor ?? 1 };
  const warm = fakeCtx([]);
  for (let i = 0; i < 20; i++) r.draw(warm, view, (clock += 200), viewer, []);
  const log: string[] = [];
  const list: Actor[] = actors.map((a) => ({ x: a.x, y: a.y, level: a.level ?? viewer.level, draw: () => { log.push(a.name); } }));
  r.draw(fakeCtx(log), view, (clock += 200), viewer, list);
  return log;
}
const P = (x: number, y: number, level?: number) => [{ name: "P", x, y, level }];

export function run(): void {
  const t = ["gr", "floor", "wall", "beam", "trim", "stairs", "roof", "outer"];
  const tiles = Object.fromEntries(t.map((id) => [id, tile()])) as MapFile["tiles"];

  // 1. Персонаж за y ніг: перед стіною (y більший) — після неї; за стіною — до неї; рівні y — тайл над персонажем.
  const r1 = make(tiles, [place("wall", 0, 0)]);
  assert.deepEqual(frame(r1, P(0, 20)), ["wall", "P"], "перед стіною — персонаж над нею");
  assert.deepEqual(frame(r1, P(0, -20)), ["P", "wall"], "за стіною — стіна над персонажем");
  assert.deepEqual(frame(r1, P(0, 0)), ["P", "wall"], "рівні y — тайл над персонажем");

  // 2. Група «земля» малюється першою і завжди під усім, хоч би яка в неї y. Вид тайла нічого не вирішує.
  const r2 = make(tiles, [place("wall", 0, 0, { z: 14 }), place("gr", 0, 500, { grp: G.ground, z: 1 }), place("floor", 0, -500, { grp: G.f1, z: 13 })]);
  assert.deepEqual(frame(r2, P(0, 10)), ["gr", "floor", "wall", "P"], "земля — перша група, далі підлога поверху за y");

  // 3. Усередині групи: менший z раніше, при рівному z — менша y.
  const r3 = make(tiles, [place("trim", 0, 0, { z: 15 }), place("wall", 0, 90, { z: 13 }), place("beam", 0, 50, { z: 13 })]);
  assert.deepEqual(frame(r3, P(0, 300)), ["beam", "wall", "trim", "P"], "z, потім y: beam(13,50) → wall(13,90) → trim(15,0)");

  // 4. Z на персонажа не діє: тайл ЗА ним (менша y) малюється до нього, хоч би який великий z; тайл ПЕРЕД ним — після, хоч би який малий z.
  const r4 = make(tiles, [place("wall", 0, 100, { z: 13 }), place("trim", 0, 0, { z: 15 })]);
  assert.deepEqual(frame(r4, P(0, 50)), ["trim", "P", "wall"], "trim (z15) за персонажем — до нього; wall (z13) перед ним — після");
  const r4b = make(tiles, [place("wall", 0, 0, { z: 99 }), place("trim", 0, 50, { z: 1 })]);
  assert.deepEqual(frame(r4b, P(0, 10)), ["wall", "P", "trim"], "великий z не піднімає тайл над персонажем, якщо той ближче до камери");

  // 5. Двоє персонажів: кожен стає у свій проміжок за y ніг.
  const r5 = make(tiles, [place("wall", 0, 0)]);
  const two = frame(r5, [{ name: "P", x: 0, y: 30 }, { name: "Q", x: 0, y: -30 }]);
  assert.deepEqual(two, ["Q", "wall", "P"], "Q за стіною, P перед нею");

  // 6. Перемичка з глибиною дверей (sy = лінія дверей): у прорізі за лінією — під нею, перед лінією — над нею.
  const r6 = make(tiles, [place("wall", -32, 0, { z: 13 }), place("beam", 0, 0, { z: 14 }), place("wall", 32, 0, { z: 13 })]);
  assert.deepEqual(frame(r6, P(0, -4)), ["P", "wall", "wall", "beam"], "у прорізі за лінією — під перемичкою");
  assert.deepEqual(frame(r6, P(0, 6)), ["wall", "wall", "beam", "P"], "перед лінією — над перемичкою");

  // 7. Сходи без спецправил: стоять над стіною за z (і y), персонаж на них бере поверх, на який піднявся.
  const r7 = make(tiles, [place("wall", 0, 40, { z: 14 }), place("stairs", 0, 40, { z: 15 }), place("floor", 0, 80, { grp: G.f2, z: 21 })]);
  assert.deepEqual(frame(r7, P(0, 60, 1), { floor: 1 }), ["wall", "stairs", "P", "floor"], "на поверсі 1: сходи над стіною, персонаж між тайлами за y ніг, поверх 2 — після");
  assert.deepEqual(frame(r7, P(0, 100, 2), { floor: 1, level: 2 }), ["wall", "stairs", "floor", "P"], "на сходах (level 2): персонаж у групі поверху 2 — після поверху 1 (стіни, сходів), за своїм y серед тайлів поверху 2");

  // 8. Поверхи: усе поверху 2 малюється після поверху 1 незалежно від y; нижні поверхи НЕ гаснуть, коли ти вище.
  const r8 = make(tiles, [place("wall", 0, 100, { grp: G.f1 }), place("floor", 0, -500, { grp: G.f2, z: 20 })]);
  assert.deepEqual(frame(r8, P(0, 0, 2), { floor: 2 }), ["wall", "floor", "P"], "нижній поверх повністю видимий (без «~»)");

  // 9. Будинок: ноги на ромбі підлоги будинку -> дах і поверхи вище поточного гаснуть; нижні лишаються. Трава без будинку нічого не вмикає.
  const houses = [{ name: "б1", diamonds: [diamond(1, 0, 0), diamond(2, 0, -64)] }];
  const r9 = make(tiles, [
    place("gr", 300, 300, { grp: G.ground, z: 1 }),
    place("wall", 0, 40, { grp: G.f1, house: 0 }),
    place("floor", 0, -64, { grp: G.f2, z: 21, house: 0 }),
    place("roof", 0, -100, { grp: G.roof, z: 35, house: 0 }),
  ], houses);
  assert.deepEqual(frame(r9, P(400, 0)), ["gr", "P", "wall", "floor", "roof"], "ззовні (на траві) будинок цілий");
  assert.deepEqual(frame(r9, P(0, 0)), ["gr", "P", "wall"], "ноги на ромбі підлоги поверху 1: поверх 2 і дах зникли");
  assert.deepEqual(frame(r9, P(0, 0, 1)).includes("floor"), false, "поверх вище гасне");
  assert.deepEqual(frame(r9, P(0, -64, 2), { floor: 2 }), ["gr", "wall", "P", "floor"], "на поверсі 2: нижній поверх видимий, дах зник");
  assert.deepEqual(frame(r9, P(34, 0)), ["gr", "P", "wall"], "запас у кілька px за краєм ромба — ще «в будинку»");
  assert.ok(frame(r9, P(60, 0)).includes("roof"), "далеко від ромба — уже зовні, дах на місці");

  // 10. Будь-яка кількість поверхів: на поверсі 2 з трьох гасне лише 3-й і дах.
  const g3 = [{ floor: 0, roof: 0 }, { floor: 1, roof: 0 }, { floor: 2, roof: 0 }, { floor: 3, roof: 0 }, { floor: 0, roof: 1 }];
  const r10 = new MapRenderer();
  const imgs10 = new Map<string, Img>(["a", "b", "c", "d"].map((id) => [id, { id } as unknown as Img]));
  r10.build({
    format: 7, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, tiles: { a: tile(), b: tile(), c: tile(), d: tile() }, groups: g3,
    houses: [{ name: "x", diamonds: [diamond(1, 0, 0), diamond(2, 0, -64), diamond(3, 0, -128)] }],
    placements: [place("a", 0, 0, { grp: 1, house: 0 }), place("b", 0, 0, { grp: 2, house: 0 }), place("c", 0, 0, { grp: 3, house: 0 }), place("d", 0, 0, { grp: 4, house: 0 })],
  }, imgs10);
  assert.deepEqual(frame(r10, P(0, -64, 2), { floor: 2 }), ["a", "P", "b"], "на поверсі 2 з трьох: поверх 3 і дах зникли, поверхи 1–2 видимі");

  console.log("render: OK");
}

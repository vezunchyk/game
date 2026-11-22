// Тест порядку малювання: група (поверх) -> плоске -> тайли і персонажі за y -> дах. Без браузера, на підставному canvas.
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

const tile = (kind: string, o: { w?: number; h?: number; flat?: boolean; interior?: number } = {}) =>
  ({ kind, flat: o.flat ? 1 : 0, interior: o.interior ?? 0, w: o.w ?? 40, h: o.h ?? 84, frames: 1, frameMs: 150, loop: 0 });
/** Групи: 0 = поверх 1, 1 = поверх 2, 2 = дах. */
const groups = [{ floor: 1, roof: 0 }, { floor: 2, roof: 0 }, { floor: 0, roof: 1 }];
/** Розміщення з точкою опори (ax, sy) у групі grp. */
const place = (id: string, ax: number, sy: number, o: { z?: number; grp?: number } = {}): Placement =>
  [id, ax - 20, sy - 84, o.z ?? 10, sy, 0, ax, sy, ax, sy, 0, ax, sy, o.grp ?? 0];

function make(tiles: MapFile["tiles"], placements: Placement[]): MapRenderer {
  const r = new MapRenderer();
  const imgs = new Map<string, Img>(Object.keys(tiles).map((id) => [id, { id } as unknown as Img]));
  r.build({ format: 6, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, tiles, groups, placements }, imgs);
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
  const tiles = {
    gr: tile("floor", { w: 64, h: 33, flat: true }), wall: tile("wall"), beam: tile("beam", { h: 60 }), trim: tile("trim"),
    stairs: tile("stairs", { w: 66, h: 97, flat: true }), roof: tile("roof", { w: 64, h: 40 }), outer: tile("wall"),
  };

  // 1. Правило y: персонаж ПЕРЕД стіною (y більший) — після неї; ЗА стіною — до неї; рівні y — тайл над персонажем.
  const r1 = make(tiles, [place("wall", 0, 0)]);
  assert.deepEqual(frame(r1, P(0, 20)), ["wall", "P"], "перед стіною — персонаж над нею");
  assert.deepEqual(frame(r1, P(0, -20)), ["P", "wall"], "за стіною — стіна над персонажем");
  assert.deepEqual(frame(r1, P(0, 0)), ["P", "wall"], "рівні y — тайл над персонажем");

  // 2. Плоске (підлога, сходи) — завжди під персонажем, хоч би яка в нього була y опори.
  const r2 = make(tiles, [place("gr", 0, 50, { z: 1 }), place("stairs", 0, 40, { z: 16 }), place("wall", 0, 0)]);
  assert.deepEqual(frame(r2, P(0, -10)), ["gr", "stairs", "P", "wall"], "підлога і сходи під персонажем, стіна за y");
  assert.deepEqual(frame(r2, P(0, 60)), ["gr", "stairs", "wall", "P"]);

  // 3. z — лише між тайлами: однакова y -> менший z раніше; z НЕ рухає персонажа.
  const r3 = make(tiles, [place("trim", 0, 0, { z: 15 }), place("wall", 0, 0, { z: 13 })]);
  assert.deepEqual(frame(r3, P(0, 30)), ["wall", "trim", "P"], "z розв'язує порядок тайлів з однаковою y");
  const r3b = make(tiles, [place("wall", 0, 0, { z: 99 }), place("trim", 0, 50, { z: 1 })]);
  assert.deepEqual(frame(r3b, P(0, 10)), ["wall", "P", "trim"], "великий z не піднімає тайл над персонажем, якщо той ближче до камери");

  // 4. Вершок (балка) з тією ж точкою опори, що й стіна: у прорізі (y за лінією) — персонаж під ним; перед лінією — над.
  const r4 = make(tiles, [place("wall", -32, 0), place("beam", 0, 0, { z: 14 }), place("wall", 32, 0)]);
  assert.deepEqual(frame(r4, P(0, -4)), ["P", "wall", "wall", "beam"], "у прорізі за лінією — під балкою");
  assert.deepEqual(frame(r4, P(0, 6)), ["wall", "wall", "beam", "P"], "перед лінією — над балкою");

  // 5. Поверхи: усе поверху 2 малюється після поверху 1, незалежно від y; персонаж іде у свій поверх.
  const r5 = make(tiles, [place("wall", 0, 100, { grp: 0 }), place("gr", 0, -500, { grp: 1, z: 20 }), place("trim", 0, -500, { grp: 1, z: 21 })]);
  assert.deepEqual(frame(r5, P(0, 0, 1), { floor: 1 }), ["P", "wall", "gr", "trim"], "поверх 2 малюється після поверху 1, хоч його y менша");
  const up = frame(r5, [{ name: "P", x: 0, y: 0, level: 2 }], { floor: 2 });
  assert.deepEqual(up, ["wall~", "gr", "trim", "P"], "поверх 1 тьмяний і першим; на 2-му: підлога, далі тайл за персонажем (менший y), потім персонаж");

  // 6. Дах: останній; ховається, коли глядач на поверсі 2+ або всередині сліду будинку.
  const house = [
    place("outer", -100, -50, { grp: 0 }), place("outer", 100, -50, { grp: 0 }), place("outer", -100, 50, { grp: 0 }), place("outer", 100, 50, { grp: 0 }),
    place("roof", 0, 0, { grp: 2, z: 35 }),
  ];
  const r6 = make(tiles, house);
  assert.deepEqual(frame(r6, P(400, 0)).slice(-1), ["roof"], "дах малюється останнім");
  assert.ok(!frame(r6, P(0, 0)).includes("roof"), "всередині сліду будинку дах зникає");
  assert.ok(!frame(r6, P(400, 0), { floor: 2 }).includes("roof"), "на поверсі 2 дах зникає");

  // 7. Нижчий поверх тьмяніє, коли глядач вище; персонаж сходів (level=2) стоїть у поверсі 2.
  const r7 = make(tiles, [place("wall", 0, 0, { grp: 0 })]);
  assert.deepEqual(frame(r7, P(0, 20, 2), { floor: 2 }), ["wall~", "P"]);

  console.log("render: OK");
}

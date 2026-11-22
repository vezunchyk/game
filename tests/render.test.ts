// Тест порядку малювання: шар -> z -> y; підлога-ромб під персонажем; будинок за групою з редактора. Без браузера, на підставному canvas.
import assert from "node:assert/strict";
import { MapRenderer, type Actor, type BuildingInfo, type MapFile, type Placement, type Viewer } from "../client/render/MapRenderer.js";

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

const tile = (o: { w?: number; h?: number; ground?: boolean } = {}) =>
  ({ w: o.w ?? 40, h: o.h ?? 84, frames: 1, frameMs: 150, loop: 0, ground: o.ground ? 1 : 0 });
/** Групи: 0 = ground (трава), 1 = поверх 1, 2 = поверх 2, 3 = дах. */
const groups = [{ floor: 0, roof: 0 }, { floor: 1, roof: 0 }, { floor: 2, roof: 0 }, { floor: 0, roof: 1 }];
/** Розміщення з точкою опори (ax, sy) у групі grp; b — номер будинку (1) або 0. */
const place = (id: string, ax: number, sy: number, o: { z?: number; grp?: number; b?: number } = {}): Placement =>
  [id, ax - 20, sy - 84, o.z ?? 10, sy, 0, ax, sy, ax, sy, 0, ax, sy, o.grp ?? 1, o.b ?? 0];

/** Будинок б1: ромб підлоги поверху 1 навколо (0, 0) і поверху 2 там само. */
const house: BuildingInfo[] = [{ name: "б1", floors: { "1": [[0, 0, 100, 50]], "2": [[0, 0, 100, 50]] } }];

function make(tiles: MapFile["tiles"], placements: Placement[], buildings: BuildingInfo[] = []): MapRenderer {
  const r = new MapRenderer();
  const imgs = new Map<string, Img>(Object.keys(tiles).map((id) => [id, { id } as unknown as Img]));
  r.build({ format: 7, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, tiles, groups, buildings, placements }, imgs);
  return r;
}

let clock = 1000; // годинник тесту (мс): час тече лише вперед, як у грі
/** Кадр: персонажі ("P", "Q") разом з картою. Перед кадром даємо прозорості дійти до цілі. */
function frame(r: MapRenderer, actors: { name: string; x: number; y: number; level?: number }[], v: Partial<Viewer> = {}): string[] {
  const me = actors[0]!;
  const viewer: Viewer = { x: v.x ?? me.x, y: v.y ?? me.y, floor: v.floor ?? 1, level: v.level ?? v.floor ?? 1 };
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
    gr: tile({ w: 66, h: 33, ground: true }), wall: tile(), beam: tile({ h: 60 }), trim: tile(), stairs: tile({ w: 66, h: 97 }),
    roof: tile({ w: 64, h: 40 }), step: tile({ w: 56, h: 40 }),
  };

  // 1. Правило y: персонаж ПЕРЕД стіною (y більший) — після неї; ЗА стіною — до неї; рівні y — тайл над персонажем.
  const r1 = make(tiles, [place("wall", 0, 0)]);
  assert.deepEqual(frame(r1, P(0, 20)), ["wall", "P"], "перед стіною — персонаж над нею");
  assert.deepEqual(frame(r1, P(0, -20)), ["P", "wall"], "за стіною — стіна над персонажем");
  assert.deepEqual(frame(r1, P(0, 0)), ["P", "wall"], "рівні y — тайл над персонажем");

  // 2. Підлога-ромб у поверсі — першою і ніколи не перекриває персонажа, хоч би яка в неї y; решта — за z, y.
  const r2 = make(tiles, [place("gr", 0, 50, { z: 13 }), place("wall", 0, 0, { z: 13 })]);
  assert.deepEqual(frame(r2, P(0, -10)), ["gr", "P", "wall"], "ромб під персонажем, стіна за y");

  // 3. Як у редакторі: z головніший за y між тайлами (менший z раніше), при рівному z — менша y раніше.
  const r3 = make(tiles, [place("trim", 0, 0, { z: 15 }), place("wall", 0, 60, { z: 14 }), place("stairs", 0, 30, { z: 14 })]);
  assert.deepEqual(frame(r3, P(0, 200)), ["stairs", "wall", "trim", "P"], "z, потім y: сходи/стіна z14 за y, бордюр z15 останнім");
  // ...і сходи не мають особливих прав: стіна z15 їх накриває, а z14 (менший) — вони накривають.
  const r3b = make(tiles, [place("stairs", 0, 100, { z: 15 }), place("wall", 0, 0, { z: 14 })]);
  assert.deepEqual(frame(r3b, P(0, 300)), ["wall", "stairs", "P"], "сходи над стіною, бо в них більший z");

  // 4. Перемичка (вершок) з глибиною дверей: у прорізі за лінією персонаж під нею, перед лінією — над.
  const r4 = make(tiles, [place("wall", -32, 0, { z: 14 }), place("beam", 0, 0, { z: 15 }), place("wall", 32, 0, { z: 14 })]);
  assert.deepEqual(frame(r4, P(0, -4)), ["P", "wall", "wall", "beam"], "у прорізі за лінією — під перемичкою");
  assert.deepEqual(frame(r4, P(0, 6)), ["wall", "wall", "beam", "P"], "перед лінією — над перемичкою");

  // 5. Групи: ground -> поверх 1 -> поверх 2 -> дах, незалежно від z і y; персонаж іде у групу свого level.
  const r5 = make(tiles, [place("wall", 0, 100, { grp: 1 }), place("gr", 0, -500, { grp: 0, z: 1 }), place("trim", 0, -500, { grp: 2, z: 21 })]);
  assert.deepEqual(frame(r5, P(0, 0, 1), { floor: 1 }), ["gr", "wall", "P", "trim"], "трава першою, поверх 2 після поверху 1 (стіна не перекриває персонажа — він далі за неї)");
  assert.deepEqual(frame(r5, [{ name: "P", x: 0, y: 0, level: 2 }], { floor: 2 }), ["gr", "wall", "trim", "P"], "персонаж поверху 2: після поверху 1; trim має y -500, менше за ноги — персонаж над ним");

  // 6. Шар ground: усе в ньому (трава, вхідні сходи) завжди під персонажем і під стінами; у ньому нема сортування з персонажем.
  const r6 = make(tiles, [place("gr", 0, 0, { grp: 0, z: 1 }), place("step", 0, 100, { grp: 0, z: 15 }), place("wall", 0, 50, { grp: 1 })]);
  assert.deepEqual(frame(r6, P(0, -30)), ["gr", "step", "P", "wall"], "сходи в шарі ground — під персонажем, хоч би яка в них y");

  // 7. БУДИНОК за групою: я на ромбі підлоги будинку — поверх 2 і дах гаснуть; трава і нижній поверх лишаються.
  const hp = (): Placement[] => [
    place("gr", 0, 300, { grp: 0, z: 1 }),                       // трава (без групи) — не гасне
    place("wall", 0, 0, { grp: 1, b: 1 }), place("trim", 0, 5, { grp: 2, b: 1, z: 21 }), place("roof", 0, 9, { grp: 3, b: 1, z: 35 }),
  ];
  const r7 = make(tiles, hp(), house);
  assert.deepEqual(frame(r7, P(500, 0)), ["gr", "wall", "P", "trim", "roof"], "поза будинком: все видно, дах останнім");
  const inside = frame(r7, P(10, 20));
  assert.ok(!inside.includes("trim") && !inside.includes("roof"), "на підлозі будинку: поверх 2 і дах зникли");
  assert.ok(inside.includes("gr") && inside.includes("wall"), "трава і мій поверх на місці");
  const up = frame(r7, [{ name: "P", x: 10, y: 20, level: 2 }], { floor: 2 });
  assert.ok(up.includes("wall") && !up.includes("wall~"), "нижній поверх не тьмяніє");
  assert.ok(up.includes("trim") && !up.includes("roof"), "на поверсі 2: поверх 2 на місці, дах зник");
  // Група, а не купка тайлів поряд: тайли без групи поряд з будинком нічого не вмикають і не гаснуть.
  const r7b = make(tiles, [place("wall", 0, 0, { grp: 1 }), place("trim", 0, 5, { grp: 2, z: 21 }), place("roof", 0, 9, { grp: 3, z: 35 })], house);
  assert.deepEqual(frame(r7b, P(10, 20)).filter((x) => x !== "P"), ["wall", "trim", "roof"], "без групи ніхто не гасне");

  // 8. Персонаж сходів (level 2) малюється у групі поверху 2 — стіна поверху 1 його не накриває.
  const r8 = make(tiles, [place("wall", 0, 0, { grp: 1 })]);
  assert.deepEqual(frame(r8, P(0, -20, 2), { floor: 1, level: 2 }), ["wall", "P"], "на сходах (level 2) — над стіною поверху 1");

  console.log("render: OK");
}

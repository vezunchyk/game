// Тести логіки руху: швидкість, діагоналі, стіни, захист від читів.
import assert from "node:assert/strict";
import { PLAYER_SPEED, TICK_RATE } from "../shared/constants.js";
import { stepPlayer, sanitizeInput, dirFromVector } from "../server/game/Movement.js";
import { isBlocked } from "../server/game/Collision.js";
import { Player } from "../server/game/Player.js";
import type { GameMap } from "../server/map/MapLoader.js";

const openMap: GameMap = { name: "open", bounds: { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }, collisions: [], byFloor: new Map(), transitions: [], stairs: [], floorMask: [], spawns: [] };

/** Симулює 1 секунду руху з наміром (ix, iy), повертає зсув НА ЕКРАНІ (швидкість однакова в усіх напрямках). */
function worldDistanceIn1s(ix: number, iy: number, map = openMap): number {
  const p = new Player(1, "t", 0, 0);
  const s = sanitizeInput(ix, iy);
  p.inputX = s.x; p.inputY = s.y; p.inputAt = Date.now();
  for (let i = 0; i < TICK_RATE; i++) { p.inputAt = Date.now(); stepPlayer(p, map, Date.now(), 600); }
  return Math.hypot(p.x, p.y);
}

export function run(): void {
  // 1. Швидкість однакова в усіх 16 напрямках (немає "подвійної" діагоналі)
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const d = worldDistanceIn1s(Math.cos(ang), Math.sin(ang));
    assert.ok(Math.abs(d - PLAYER_SPEED) < 1, `напрямок ${a}: пройдено ${d.toFixed(2)}, очікувалось ${PLAYER_SPEED}`);
  }
  // 2. Читерський вектор (1000, 1000) обрізається до довжини 1
  const cheat = worldDistanceIn1s(1000, 1000);
  assert.ok(Math.abs(cheat - PLAYER_SPEED) < 1, `читерський вектор дав ${cheat}`);
  // 3. Сміття (NaN, Infinity, рядки) = стоїмо
  assert.deepEqual(sanitizeInput(NaN, Infinity), { x: 0, y: 0 });
  assert.deepEqual(sanitizeInput("5", {}), { x: 0, y: 0 });
  // 4. Слабкий нахил джойстика повільніший (аналог), але не швидший
  const half = worldDistanceIn1s(0.5, 0);
  assert.ok(Math.abs(half - PLAYER_SPEED * 0.5) < 1, `половина нахилу: ${half}`);
  // 5. Стіна зупиняє, і "прошити" її на повній швидкості не можна
  const wallPoly = { floor: 1, pts: [40, -50, 44, -50, 44, 50, 40, 50], minX: 40, minY: -50, maxX: 44, maxY: 50 };
  const wall: GameMap = { ...openMap, collisions: [wallPoly], byFloor: new Map([[1, [wallPoly]]]) };
  const p = new Player(1, "t", 0, 0);
  p.inputX = 1; p.inputY = 0;
  for (let i = 0; i < 200; i++) { p.inputAt = Date.now(); stepPlayer(p, wall, Date.now(), 600); }
  assert.ok(p.x < 40, `пройшов крізь стіну, x=${p.x}`);
  assert.ok(!isBlocked(wall, p.x, p.y), "гравець застряг у стіні");
  // 6. Вихід за межі світу заборонений
  const tiny: GameMap = { ...openMap, bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 } };
  const q = new Player(2, "t", 0, 0); q.inputX = 1; q.inputY = 1;
  for (let i = 0; i < 100; i++) { q.inputAt = Date.now(); stepPlayer(q, tiny, Date.now(), 600); }
  assert.ok(q.x <= 10 && q.y <= 10, "вийшов за межі");
  // 7. Таймаут input: джойстик "завис" — гравець зупиняється
  const r = new Player(3, "t", 0, 0); r.inputX = 1; r.inputAt = Date.now() - 5000;
  stepPlayer(r, openMap, Date.now(), 600);
  assert.equal(r.x, 0);
  // 8. Напрямки
  assert.equal(dirFromVector(0, 1), 0); // S
  assert.equal(dirFromVector(1, 0), 2); // E
  assert.equal(dirFromVector(0, -1), 4); // N
  assert.equal(dirFromVector(-1, 0), 6); // W
  // 9. Сходи: піднімаємось "по рейці" крізь колізію стіни збоку/поперек (вона не заважає), поверх міняється, зверху можна йти
  const wallAcross = { floor: 1, pts: [-20, -45, 20, -45, 20, -35, -20, -35], minX: -20, minY: -45, maxX: 20, maxY: -35 };
  const stairMap: GameMap = {
    ...openMap, collisions: [wallAcross], byFloor: new Map([[1, [wallAcross]]]),
    stairs: [{ id: "s", low: 1, high: 2, ax: 0, ay: 0, bx: 0, by: -80, len: 80, ex: 0, ey: -1, nx: 1, ny: 0 }],
  };
  const c = new Player(4, "t", 0, 6);
  for (let i = 0; i < 60; i++) { c.inputX = 0; c.inputY = -1; c.inputAt = Date.now(); stepPlayer(c, stairMap, Date.now(), 600); }
  assert.equal(c.floor, 2, "піднявся на поверх 2");
  assert.ok(c.y < -80, `пройшов крізь сходи вгору, y=${c.y}`);
  assert.equal(c.stair, -1, "зійшов зі сходів нагору");
  // 10. Повз вхід у сходи горизонтально — не залипає
  const d = new Player(5, "t", 20, 0);
  for (let i = 0; i < 20; i++) { d.inputX = -1; d.inputY = 0; d.inputAt = Date.now(); stepPlayer(d, stairMap, Date.now(), 600); }
  assert.equal(d.stair, -1);
  assert.equal(d.floor, 1);
  // 11. Застряг ВСЕРЕДИНІ колізії — його виштовхує на вільне місце (раніше назавжди застрягав)
  const blob = { floor: 1, pts: [-30, -30, 30, -30, 30, 30, -30, 30], minX: -30, minY: -30, maxX: 30, maxY: 30 };
  const blobMap: GameMap = { ...openMap, collisions: [blob], byFloor: new Map([[1, [blob]]]) };
  const e = new Player(6, "t", 5, 3);
  stepPlayer(e, blobMap, Date.now(), 600); // навіть без руху
  assert.ok(Math.abs(e.x) > 30 + 7 || Math.abs(e.y) > 30 + 3, `лишився в колізії: ${e.x},${e.y}`);
  console.log("movement: OK");
}

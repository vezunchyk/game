// ============================================================================
// server/game/Movement.ts
// Рух гравця. ТУТ вирішується, наскільки і куди він реально перемістився.
//
// Захист від "подвійної швидкості":
//  1. Вектор наміру ОДИН на гравця (новий input перезаписує старий, а не додається).
//  2. Рух робиться РІВНО ОДИН раз за тік з фіксованим кроком TICK_DT.
//  3. Вектор нормалізується (довжина <= 1), тож діагональ не швидша за пряму.
//  4. Швидкість однакова НА ЕКРАНІ в усіх напрямках (вгору/вниз по екрану не повільніше, ніж убік).
//     (Раніше рахувалась у "світових" одиницях ізометрії 2:1 — тоді вгору виходило вдвічі повільніше.)
// ============================================================================
import { Dir, INPUT_DEADZONE, ISO_Y_SCALE, PLAYER_SPEED, TICK_DT } from "../../shared/constants.js";
import type { GameMap, Stair } from "../map/MapLoader.js";
import { isBlocked, pointInPoly } from "./Collision.js";
import type { Player } from "./Player.js";

/** Максимальний крок за одну підітерацію (пікселі) — щоб не "прошивати" тонкі стіни. */
const MAX_SUBSTEP = 2;

/** Напрямок (0..7) з екранного вектора. */
export function dirFromVector(dx: number, dy: number): number {
  // atan2(dx, dy): S=0, E=pi/2, N=pi, W=-pi/2. Ділимо на 45° і округлюємо.
  const sector = Math.round(Math.atan2(dx, dy) / (Math.PI / 4));
  return ((sector % 8) + 8) % 8;
}

/** Очищає вхідний вектор: скінченні числа, довжина не більше 1, мертва зона. */
export function sanitizeInput(dx: unknown, dy: unknown): { x: number; y: number } {
  let x = typeof dx === "number" && Number.isFinite(dx) ? dx : 0;
  let y = typeof dy === "number" && Number.isFinite(dy) ? dy : 0;
  const len = Math.hypot(x, y);
  if (len < INPUT_DEADZONE) return { x: 0, y: 0 };
  if (len > 1) { x /= len; y /= len; } // головне: більше 1 ніколи не буває
  return { x, y };
}

/** Один тік руху одного гравця. */
export function stepPlayer(player: Player, map: GameMap, now: number, inputTimeoutMs: number): void {
  // Якщо давно немає input — вважаємо, що джойстик відпущено.
  if (now - player.inputAt > inputTimeoutMs) {
    player.inputX = 0;
    player.inputY = 0;
  }

  // Застряг усередині колізії (після зміни поверху, на тонкій стіні, у куті) — виштовхуємо ДО будь-якого руху,
  // навіть коли джойстик відпущено: інакше з \"закритої\" точки не вийти в жодний бік.
  if (player.stair < 0) unstuck(player, map);

  const len = Math.hypot(player.inputX, player.inputY);
  if (len === 0) {
    player.moving = false;
    return;
  }

  // Напрямок на екрані (одиничний) і сила натиску (0..1)
  const ux = player.inputX / len;
  const uy = player.inputY / len;
  const strength = Math.min(len, 1);

  // Швидкість на екрані однакова в усіх напрямках (ux, uy — одиничний вектор).
  const screenSpeed = PLAYER_SPEED * strength;

  const totalX = ux * screenSpeed * TICK_DT;
  const totalY = uy * screenSpeed * TICK_DT;

  // На сходах — рух по \"рейці\" (колізії стін там не діють, див. нижче).
  if (player.stair >= 0) {
    const x0 = player.x, y0 = player.y;
    stepOnStairs(player, map, totalX, totalY);
    player.moving = player.x !== x0 || player.y !== y0;
    player.dir = dirFromVector(ux, uy);
    return;
  }

  // Рухаємось малими кроками, по осях окремо — так гравець "ковзає" вздовж стін.
  const steps = Math.max(1, Math.ceil(Math.hypot(totalX, totalY) / MAX_SUBSTEP));
  const sx = totalX / steps;
  const sy = totalY / steps;
  const startX = player.x;
  const startY = player.y;
  for (let i = 0; i < steps; i++) moveAndSlide(player, map, sx, sy);

  tryEnterStairs(player, map, ux, uy);
  updateFloor(player, map);
  if (player.stair < 0) unstuck(player, map);
  player.moving = player.x !== startX || player.y !== startY;
  // Тисне, а стоїть на місці — і навколо майже немає вільного місця (кут, щілина): відкидаємо на кілька пікселів.
  if (player.moving) player.pinTicks = 0;
  else if (++player.pinTicks >= PIN_TICKS && player.stair < 0) {
    if (clearance(map, player.x, player.y, player.floor) <= PIN_MAX_CLEARANCE) ejectFromPocket(player, map);
    player.pinTicks = 0;
  }
  // Напрямок беремо з бажаного руху (щоб персонаж повертався до стіни, а не завмирав)
  player.dir = dirFromVector(ux, uy);
}

/** Вхід у зону зміни поверху (сходи): гравець з поверху onFloor переноситься на toFloor. Лише при вході ззовні. */
export function updateFloor(player: Player, map: GameMap): void {
  let inside = false;
  for (const t of map.transitions) {
    if (!pointInPoly(player.x, player.y, t)) continue;
    inside = true;
    if (!player.inTransition && player.floor === t.onFloor) {
      player.floor = t.toFloor;
      break;
    }
  }
  player.inTransition = inside;
}

/**
 * СХОДИ. Усередині коридору сходів персонаж рухається по \"рейці\": вздовж осі низ -> верх (швидкість —
 * проєкція джойстика на цю вісь) і трохи вбік (до STAIR_HALF_WIDTH). Колізії стін поряд зі сходами тут НЕ
 * перевіряються — інакше стіна будинку, до якої притиснуті сходи, не пускає вгору. Зійти зі сходів можна лише
 * з кінців: знизу — на поверх low, зверху — на плиту поверху high (там уже діють звичайні колізії).
 * Поверх (для малювання й колізій) міняється посередині сходів.
 */
const STAIR_HALF_WIDTH = 8;
/** Скільки убік від осі ще \"засмоктує\" на сходи при вході (px). */
const STAIR_MOUTH_WIDTH = 16;
/** Зона входу вздовж осі біля кожного кінця (px: до кінця, за кінець). */
const STAIR_MOUTH_IN = 10;
const STAIR_MOUTH_OUT = 6;
/** Наскільки джойстик має дивитись У СХОДИ (cos кута до осі), щоб зайти: проходячи повз, не залипаєш. */
const STAIR_ENTER_DOT = 0.6;

function stairCoords(s: Stair, x: number, y: number): { along: number; lat: number } {
  const px = x - s.ax, py = y - s.ay;
  return { along: px * s.ex + py * s.ey, lat: px * s.nx + py * s.ny };
}

function placeOnStair(player: Player, s: Stair, along: number, lat: number): void {
  player.x = s.ax + s.ex * along + s.nx * lat;
  player.y = s.ay + s.ey * along + s.ny * lat;
}

/** Після звичайного руху: чи зайшов гравець у \"рот\" сходів, дивлячись на них. */
export function tryEnterStairs(player: Player, map: GameMap, ux: number, uy: number): void {
  for (let i = 0; i < map.stairs.length; i++) {
    const s = map.stairs[i]!;
    const { along, lat } = stairCoords(s, player.x, player.y);
    if (Math.abs(lat) > STAIR_MOUTH_WIDTH) continue;
    const dot = ux * s.ex + uy * s.ey; // > 0 — дивиться вгору по сходах
    if (player.floor === s.low && along >= -STAIR_MOUTH_OUT && along <= STAIR_MOUTH_IN && dot > STAIR_ENTER_DOT) {
      player.stair = i;
      placeOnStair(player, s, Math.max(0, along), Math.max(-STAIR_HALF_WIDTH, Math.min(STAIR_HALF_WIDTH, lat)));
      return;
    }
    if (player.floor === s.high && along >= s.len - STAIR_MOUTH_IN && along <= s.len + STAIR_MOUTH_OUT && -dot > STAIR_ENTER_DOT) {
      player.stair = i;
      placeOnStair(player, s, Math.min(s.len, along), Math.max(-STAIR_HALF_WIDTH, Math.min(STAIR_HALF_WIDTH, lat)));
      return;
    }
  }
}

/** Один крок по сходах: (dx, dy) — екранний зсув за тік. */
function stepOnStairs(player: Player, map: GameMap, dx: number, dy: number): void {
  const s = map.stairs[player.stair]!;
  let { along, lat } = stairCoords(s, player.x, player.y);
  along += dx * s.ex + dy * s.ey;
  lat = Math.max(-STAIR_HALF_WIDTH, Math.min(STAIR_HALF_WIDTH, lat + dx * s.nx + dy * s.ny));

  if (along <= 0) {
    // Зійшов униз: на поверх low, далі звичайний рух.
    placeOnStair(player, s, 0, lat);
    player.floor = s.low;
    player.stair = -1;
    unstuck(player, map); // низ сходів притиснутий до стіни: одразу відкидаємо на вільне місце
    return;
  }
  if (along >= s.len) {
    placeOnStair(player, s, s.len, lat);
    if (!isBlocked(map, player.x, player.y, s.high)) {
      player.floor = s.high;
      player.stair = -1;
    }
    return; // верх не вільний (немає підлоги/колізія) — лишаємось на останній сходинці
  }
  placeOnStair(player, s, along, lat);
  player.floor = along < s.len * 0.5 ? s.low : s.high;
}

/** Найдальше, куди ще повертаємось на "останню вільну" точку (px); далі шукаємо найближче вільне місце. */
const UNSTUCK_BACK_MAX = 24;
/** Радіус пошуку вільного місця (px) і крок кільця. */
const UNSTUCK_SEARCH_R = 64;

/**
 * Якщо гравець стоїть у зайнятій точці — відкидаємо його: спершу на останню вільну позицію (вона була
 * кілька пікселів тому), інакше на найближче вільне місце по спіралі (Y стиснуто вдвічі — ізометрія).
 * Якщо точка вільна — запам'ятовуємо її як "останню добру".
 */
export function unstuck(player: Player, map: GameMap): void {
  if (!isBlocked(map, player.x, player.y, player.floor)) {
    player.goodX = player.x; player.goodY = player.y; player.goodFloor = player.floor;
    return;
  }
  if (
    player.goodFloor === player.floor &&
    Math.hypot(player.goodX - player.x, player.goodY - player.y) <= UNSTUCK_BACK_MAX &&
    !isBlocked(map, player.goodX, player.goodY, player.floor)
  ) {
    player.x = player.goodX; player.y = player.goodY;
    return;
  }
  for (let r = 1; r <= UNSTUCK_SEARCH_R; r++) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const nx = player.x + Math.cos(a) * r, ny = player.y + Math.sin(a) * r * ISO_Y_SCALE;
      if (!isBlocked(map, nx, ny, player.floor)) {
        player.x = nx; player.y = ny;
        player.goodX = nx; player.goodY = ny; player.goodFloor = player.floor;
        return;
      }
    }
  }
}

/** Скільки тіків тиску без руху вважаємо "застряг" (20 тіків/с => 0.25 с). */
const PIN_TICKS = 5;
/** Скільки з 16 напрямків навколо мають бути вільні, щоб місце вважалось нормальним (стіна: ~8, кут: ~4, щілина: ≤3). */
const PIN_MAX_CLEARANCE = 5;
const ROOMY_CLEARANCE = 8;

/** Скільки з 16 напрямків на відстані 5 px від точки вільні (міра того, наскільки \"тісно\"). */
function clearance(map: GameMap, x: number, y: number, floor: number): number {
  let n = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    if (!isBlocked(map, x + Math.cos(a) * 5, y + Math.sin(a) * 5 * ISO_Y_SCALE, floor)) n++;
  }
  return n;
}

/** Відкидає гравця з кишені/кута на найближче місце, де довкола досить вільно (до ~24 px). */
function ejectFromPocket(player: Player, map: GameMap): void {
  for (let r = 2; r <= 24; r += 2) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const nx = player.x + Math.cos(a) * r, ny = player.y + Math.sin(a) * r * ISO_Y_SCALE;
      // Лише туди, куди можна дійти по прямій: відкидання не має переносити крізь стіну на другий бік.
      if (!isBlocked(map, nx, ny, player.floor) && clearance(map, nx, ny, player.floor) >= ROOMY_CLEARANCE && segmentFree(map, player.x, player.y, nx, ny, player.floor)) {
        player.x = nx; player.y = ny;
        player.goodX = nx; player.goodY = ny; player.goodFloor = player.floor;
        return;
      }
    }
  }
}

/**
 * Крок із ковзанням уздовж перешкоди. Якщо пряме місце зайняте — оцінюємо нормаль перешкоди (звідки вона тисне)
 * і йдемо вздовж неї. Рахуємо в "світових" координатах (Y розтягнуто вдвічі), тож вздовж діагональних стін
 * ізометрії гравець ковзає плавно, а не \"сходинками\" по осях, — це і є різниця між \"то проходить у двері, то ні\".
 */
function moveAndSlide(player: Player, map: GameMap, sx: number, sy: number): void {
  const f = player.floor;
  const tx = player.x + sx, ty = player.y + sy;
  if (!isBlocked(map, tx, ty, f)) { player.x = tx; player.y = ty; return; }

  // Нормаль: напрямки (у світі), в яких навколо цілі зайнято — розвертаємо "від" них.
  let nx = 0, ny = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, cx = Math.cos(a), cy = Math.sin(a);
    if (isBlocked(map, tx + cx * 3, ty + cy * 3 * ISO_Y_SCALE, f)) { nx -= cx; ny -= cy; }
  }
  const nl = Math.hypot(nx, ny);
  if (nl > 1e-6) {
    nx /= nl; ny /= nl;
    const vx = sx, vy = sy / ISO_Y_SCALE; // швидкість у світових координатах
    const dot = vx * nx + vy * ny;
    if (dot < 0) {
      const ax = vx - dot * nx, ay = (vy - dot * ny) * ISO_Y_SCALE; // уздовж перешкоди
      if (!isBlocked(map, player.x + ax, player.y + ay, f)) { player.x += ax; player.y += ay; return; }
    }
  }
  // Запасний варіант: по осях окремо.
  if (!isBlocked(map, player.x + sx, player.y, f)) player.x += sx;
  if (!isBlocked(map, player.x, player.y + sy, f)) player.y += sy;
}

/** Чи вільна пряма між двома точками (перевірка кожні ~1.5 px). */
function segmentFree(map: GameMap, x0: number, y0: number, x1: number, y1: number, floor: number): boolean {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 1.5);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (isBlocked(map, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, floor)) return false;
  }
  return true;
}

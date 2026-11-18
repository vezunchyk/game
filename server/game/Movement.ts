// ============================================================================
// server/game/Movement.ts
// Рух гравця. ТУТ вирішується, наскільки і куди він реально перемістився.
//
// Захист від "подвійної швидкості":
//  1. Вектор наміру ОДИН на гравця (новий input перезаписує старий, а не додається).
//  2. Рух робиться РІВНО ОДИН раз за тік з фіксованим кроком TICK_DT.
//  3. Вектор нормалізується (довжина <= 1), тож діагональ не швидша за пряму.
//  4. Швидкість рахується в "світових" одиницях (ізометрія 2:1), тому
//     вгору/вниз по екрану не повільніше і не швидше, ніж убік.
// ============================================================================
import { Dir, INPUT_DEADZONE, ISO_Y_SCALE, PLAYER_SPEED, TICK_DT } from "../../shared/constants.js";
import type { GameMap } from "../map/MapLoader.js";
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

  const len = Math.hypot(player.inputX, player.inputY);
  if (len === 0) {
    player.moving = false;
    return;
  }

  // Напрямок на екрані (одиничний) і сила натиску (0..1)
  const ux = player.inputX / len;
  const uy = player.inputY / len;
  const strength = Math.min(len, 1);

  // Швидкість на екрані така, щоб у СВІТІ вона була однаковою в усіх напрямках:
  // екранний крок = швидкість / sqrt(ux² + (uy/ISO_Y_SCALE)²)
  const k = Math.hypot(ux, uy / ISO_Y_SCALE);
  const screenSpeed = (PLAYER_SPEED * strength) / k;

  const totalX = ux * screenSpeed * TICK_DT;
  const totalY = uy * screenSpeed * TICK_DT;

  // Рухаємось малими кроками, по осях окремо — так гравець "ковзає" вздовж стін.
  const steps = Math.max(1, Math.ceil(Math.hypot(totalX, totalY) / MAX_SUBSTEP));
  const sx = totalX / steps;
  const sy = totalY / steps;
  const startX = player.x;
  const startY = player.y;
  for (let i = 0; i < steps; i++) {
    if (!isBlocked(map, player.x + sx, player.y, player.floor)) player.x += sx;
    if (!isBlocked(map, player.x, player.y + sy, player.floor)) player.y += sy;
  }

  updateFloor(player, map);
  player.moving = player.x !== startX || player.y !== startY;
  // Напрямок беремо з бажаного руху (щоб персонаж повертався до стіни, а не завмирав)
  player.dir = dirFromVector(ux, uy);
}

/** Вхід у зону зміни поверху (сходи): гравець з поверху onFloor переноситься на toFloor. Лише при вході ззовні. */
export function updateFloor(player: Player, map: GameMap): void {
  updateStairs(player, map);
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

/** Півширина коридору сходів (px по перпендикуляру до їх осі). */
const STAIR_HALF_WIDTH = 30;
/**
 * Де міняється поверх (u: 0 = низ сходів, 1 = верх). Міняємо БІЛЯ НИЗУ, а не посередині: на поверсі 1
 * прохід по сходах перекритий колізіями вже на ~25% довжини (під сходами), а на поверсі 2 сходи вільні
 * по всій довжині — тож піднявся трохи — вже на поверсі 2. Два пороги (гістерезис), щоб не смикало.
 */
const STAIR_UP_AT = 0.15;
const STAIR_DOWN_AT = 0.1;
/** Гравець \"сідає\" на сходи, лише зайшовши з кінця: з низу на нижньому поверсі, з верху на верхньому. */
const STAIR_TOP_ENTRY = 0.65;

/**
 * Сходи: гравець іде по відрізку a -> b ПРЯМО НА ЕКРАНІ (сходи в картинці вже нахилені вгору), тому підйом
 * малювати окремо не треба. Підходиш знизу і піднімаєшся — стаєш на поверх high; спускаєшся — назад на low.
 * Заходити на сходи збоку (посередині) не можна — лише з кінця.
 */
export function updateStairs(player: Player, map: GameMap): void {
  if (player.stair >= 0) {
    const s = map.stairs[player.stair]!;
    const { u, lat } = stairCoords(s, player.x, player.y);
    if (Math.abs(lat) > STAIR_HALF_WIDTH || u < -0.1 || u > 1.1) {
      // Зійшов зі сходів убік/з кінця: біля низу — повертаємо на нижній поверх, нагорі лишаємось на верхньому.
      if (player.floor === s.high && u < 0.5) player.floor = s.low;
      player.stair = -1;
      return;
    }
    if (player.floor === s.low && u >= STAIR_UP_AT) player.floor = s.high;
    else if (player.floor === s.high && u < STAIR_DOWN_AT) player.floor = s.low;
    return;
  }
  for (let i = 0; i < map.stairs.length; i++) {
    const s = map.stairs[i]!;
    if (player.floor !== s.low && player.floor !== s.high) continue;
    const { u, lat } = stairCoords(s, player.x, player.y);
    if (Math.abs(lat) > STAIR_HALF_WIDTH || u < -0.1 || u > 1.1) continue;
    const fromEnd = player.floor === s.low ? u < STAIR_UP_AT : u > STAIR_TOP_ENTRY;
    if (fromEnd) { player.stair = i; return; }
  }
}

/** Положення точки відносно сходів: u — вздовж (0 = низ, 1 = верх), lat — відстань убік (px). */
function stairCoords(s: { ax: number; ay: number; bx: number; by: number }, x: number, y: number): { u: number; lat: number } {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const len = Math.hypot(dx, dy) || 1;
  const px = x - s.ax, py = y - s.ay;
  return { u: (px * dx + py * dy) / (len * len), lat: (px * -dy + py * dx) / len };
}

// ============================================================================
// server/game/Collision.ts
// Перевірка: чи можна гравцю стояти в точці (x, y).
// "Ноги" персонажа — маленький еліпс (в ізометрії коло виглядає еліпсом).
// ============================================================================
import { FOOT_RADIUS_X, FOOT_RADIUS_Y } from "../../shared/constants.js";
import type { GameMap, Poly } from "../map/MapLoader.js";

/** Чи лежить точка всередині багатокутника (алгоритм променя). */
export function pointInPoly(px: number, py: number, poly: Poly): boolean {
  if (px < poly.minX || px > poly.maxX || py < poly.minY || py > poly.maxY) return false;
  const p = poly.pts;
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i]!, yi = p[i + 1]!, xj = p[j]!, yj = p[j + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 8 контрольних точок по краю "ніг" + центр. */
const FOOT_SAMPLES: [number, number][] = [
  [0, 0],
  [FOOT_RADIUS_X, 0], [-FOOT_RADIUS_X, 0],
  [0, FOOT_RADIUS_Y], [0, -FOOT_RADIUS_Y],
  [FOOT_RADIUS_X * 0.7, FOOT_RADIUS_Y * 0.7], [-FOOT_RADIUS_X * 0.7, FOOT_RADIUS_Y * 0.7],
  [FOOT_RADIUS_X * 0.7, -FOOT_RADIUS_Y * 0.7], [-FOOT_RADIUS_X * 0.7, -FOOT_RADIUS_Y * 0.7],
];

/** true — в цій точці на цьому поверсі стояти НЕ можна (перешкода поверху floor або вихід за межі світу). */
export function isBlocked(map: GameMap, x: number, y: number, floor = 1): boolean {
  const b = map.bounds;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return true;
  for (const poly of map.byFloor.get(floor) ?? []) {
    // Швидка відсічка по габариту (з запасом на розмір ніг)
    if (x + FOOT_RADIUS_X < poly.minX || x - FOOT_RADIUS_X > poly.maxX) continue;
    if (y + FOOT_RADIUS_Y < poly.minY || y - FOOT_RADIUS_Y > poly.maxY) continue;
    for (const [dx, dy] of FOOT_SAMPLES) {
      if (pointInPoly(x + dx, y + dy, poly)) return true;
    }
  }
  return false;
}

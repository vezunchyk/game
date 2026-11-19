// ============================================================================
// server/map/MapLoader.ts
// Завантажує серверну частину карти: межі, колізії, спавни.
// Картинок тут немає — сервер їх не потребує.
// ============================================================================
import fs from "node:fs";

/** Один суцільний багатокутник-перешкода. */
export interface Poly {
  /** Поверх, на якому діє ця колізія (1, 2, 3...). */
  floor: number;
  /** Вершини [x, y, x, y, ...] у вигляді плоского масиву (швидше для перебору). */
  pts: number[];
  /** Габаритний прямокутник — швидко відсіює полігони, які точно не підходять. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Зона переходу між поверхами (сходи). */
export interface Transition extends Poly {
  /** Діє лише для гравця, що стоїть на цьому поверсі. */
  onFloor: number;
  /** Куди переносить гравця при вході в зону. */
  toFloor: number;
}

/** Сходи між двома поверхами: відрізок a (низ, поверх low) -> b (верх, поверх high). */
export interface Stair {
  id: string;
  low: number;
  high: number;
  /** Низ сходів (початок рейки). */
  ax: number; ay: number;
  /** Верх: кінець рейки, вже на плиті верхнього поверху. */
  bx: number; by: number;
  /** Довжина рейки (px) і одиничні вектори: e — уздовж (вгору), n — убік. */
  len: number;
  ex: number; ey: number;
  nx: number; ny: number;
}

/** Ромб підлоги поверху 2+: гравець на цьому поверсі стоїть лише всередині ромбів (див. isBlocked). */
export interface FloorTile { floor: number; cx: number; cy: number; hw: number; hh: number; }

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GameMap {
  name: string;
  bounds: Bounds;
  collisions: Poly[];
  /** Колізії, розкладені по поверхах: floors.get(n) — лише ті, що діють на поверсі n. */
  byFloor: Map<number, Poly[]>;
  transitions: Transition[];
  stairs: Stair[];
  floorMask: FloorTile[];
  /** Точки спавну, задані в редакторі. Якщо порожньо — сервер шукає вільне місце сам. */
  spawns: { x: number; y: number }[];
}

function toPoly(c: { pts: [number, number][] }, floor: number): Poly {
  const pts: number[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of c.pts) {
    pts.push(x, y);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { floor, pts, minX, minY, maxX, maxY };
}

export function loadMap(file: string): GameMap {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  // Відсутнє поле floor (стара збірка) = поверх 1.
  const collisions: Poly[] = raw.collisions.map((c: { pts: [number, number][]; floor?: number }) => toPoly(c, c.floor ?? 1));
  const byFloor = new Map<number, Poly[]>();
  for (const p of collisions) {
    if (!byFloor.has(p.floor)) byFloor.set(p.floor, []);
    byFloor.get(p.floor)!.push(p);
  }
  const transitions: Transition[] = (raw.transitions ?? []).map(
    (t: { pts: [number, number][]; onFloor: number; toFloor: number }) => ({ ...toPoly(t, t.onFloor), onFloor: t.onFloor, toFloor: t.toFloor }),
  );
  const stairs: Stair[] = (raw.stairs ?? []).map(
    (s: { id: string; low: number; high: number; a: [number, number]; top: [number, number] }) => {
      const dx = s.top[0] - s.a[0], dy = s.top[1] - s.a[1], len = Math.hypot(dx, dy) || 1;
      const ex = dx / len, ey = dy / len;
      return { id: s.id, low: s.low, high: s.high, ax: s.a[0], ay: s.a[1], bx: s.top[0], by: s.top[1], len, ex, ey, nx: -ey, ny: ex };
    },
  );
  const floorMask: FloorTile[] = (raw.floorMask ?? []).map(
    ([floor, cx, cy, hw, hh]: [number, number, number, number, number]) => ({ floor, cx, cy, hw, hh }),
  );
  return { name: raw.name, bounds: raw.bounds, collisions, byFloor, transitions, stairs, floorMask, spawns: raw.spawns };
}

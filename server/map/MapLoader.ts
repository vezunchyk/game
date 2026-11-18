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
  return { name: raw.name, bounds: raw.bounds, collisions, byFloor, transitions, spawns: raw.spawns };
}

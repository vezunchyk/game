// ============================================================================
// server/map/MapLoader.ts
// Завантажує серверну частину карти: межі, колізії, спавни.
// Картинок тут немає — сервер їх не потребує.
// ============================================================================
import fs from "node:fs";

/** Один суцільний багатокутник-перешкода. */
export interface Poly {
  /** Вершини [x, y, x, y, ...] у вигляді плоского масиву (швидше для перебору). */
  pts: number[];
  /** Габаритний прямокутник — швидко відсіює полігони, які точно не підходять. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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
  /** Точки спавну, задані в редакторі. Якщо порожньо — сервер шукає вільне місце сам. */
  spawns: { x: number; y: number }[];
}

export function loadMap(file: string): GameMap {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const collisions: Poly[] = raw.collisions.map((c: { pts: [number, number][] }) => {
    const pts: number[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of c.pts) {
      pts.push(x, y);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { pts, minX, minY, maxX, maxY };
  });
  return { name: raw.name, bounds: raw.bounds, collisions, spawns: raw.spawns };
}

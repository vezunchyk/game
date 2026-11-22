// ============================================================================
// client/render/MapRenderer.ts
// Малює карту з TileWeaver. Одне правило порядку для всіх будинків:
//
//   1. ГРУПИ (поверхи) йдуть по черзі: поверх 1, поверх 2, ..., дах. Група = шари редактора,
//      зведені в map-src/render-rules.json (напр. «підлога»+«середина 1»+«зовні 1» = поверх 1).
//   2. Усередині поверху:
//        а) плоске (підлога, сходи — flat) — першим, за (z, y), персонажі його ніколи не перекривають;
//        б) решта + персонажі — ОДНИМ списком за y точки опори (чим нижче на екрані, тим пізніше).
//           Рівні y: персонаж раніше, тайл поверх нього. Рівні y у тайлів: менший z раніше.
//   3. Дах — у своїй групі останнім, зникає, коли глядач у будинку.
//
// z — це лише порядок тайлів між собою; на персонажа він не діє.
// Точка опори тайла (ax, sy) — ребро ромба клітинки з редактора; збірка карти кладе її в map.json.
// Жодних правил «для цього виду тайла»: новий вид = ті самі дані, ті самі правила.
// ============================================================================

/** Як швидко верх будинку зникає/з'являється (за секунду, 0..1). */
const FADE_PER_SEC = 5;
/** Прозорість нижчих поверхів, коли глядач на поверсі вище. */
const LOWER_FLOOR_ALPHA = 0.3;
/** Тайли ближче одне до одного ніж це (світові px) вважаються одним будинком. */
const BUILDING_GAP = 24;
/** Зовнішні стіни в такому радіусі від будинку задають його слід на землі. */
const FOOTPRINT_SEARCH = 160;
const FOOTPRINT_PAD = 8;

interface TileInfo {
  kind: string; flat: number; interior: number;
  w: number; h: number; frames: number; frameMs: number; loop: number;
}
interface GroupInfo { floor: number; roof: number; }

/** [id, x0, y0, z, key, flags(1=flipX,2=flipY), gx, gy, pvx, pvy, axis, ax, sy, група] — клієнту потрібні не всі. */
export type Placement = [string, number, number, number, number, number, number, number, number, number, number, number, number, number];

export interface MapFile {
  format?: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  tiles: Record<string, TileInfo>;
  groups: GroupInfo[];
  placements: Placement[];
}

export interface View { left: number; top: number; right: number; bottom: number; }

/** Один готовий до малювання тайл. */
interface Item {
  img: HTMLImageElement;
  x: number; y: number; w: number; h: number;
  frames: number; frameMs: number; loop: boolean;
  flipX: boolean; flipY: boolean;
  /** Точка, навколо якої віддзеркалюється. */
  pvx: number; pvy: number;
  z: number;
  /** Точка опори: за sy сортуємо, за (ax, sy) шукаємо слід будинку. */
  ax: number; sy: number;
  /** Індекс групи в MapRenderer.groups. */
  group: number;
  /** Зовнішня стіна першого поверху — задає слід будинку. */
  outerWall: boolean;
  building: Building | null;
}

/** Персонаж: сортується разом з тайлами свого поверху за y ніг. */
export interface Actor {
  x: number; y: number;
  /** Поверх, на якому він стоїть (на сходах — верхній). */
  level: number;
  draw: () => void;
}

/** Хто дивиться: його поверх, поверх для малювання (на сходах — верхній) і позиція ніг. */
export interface Viewer { x: number; y: number; floor: number; level: number; }

interface Group { floor: number; roof: boolean; back: Item[]; stand: Item[]; }

/** Верх одного будинку: тайли поверхів над глядачем і даху зникають разом. */
interface Building {
  left: number; top: number; right: number; bottom: number;
  fp: { left: number; top: number; right: number; bottom: number } | null;
  roofAlpha: number;
  upperAlpha: number;
}

export class MapRenderer {
  bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private groups: Group[] = [];
  private buildings: Building[] = [];
  private lastFadeTime = 0;

  async load(): Promise<void> {
    const map = (await (await fetch("/assets/map.json", { cache: "no-store" })).json()) as MapFile;
    if (map.format !== 6) {
      // Клієнт і карта з різних версій — малювати нічого, інакше вийде «каша».
      const msg = "Версії не збігаються: map.json старий (format " + map.format + "), а клієнт новий. Онови всю гру з одного архіву.";
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;inset:0;z-index:99;background:#300;color:#fff;padding:24px;font:18px sans-serif";
      d.textContent = msg;
      document.body.appendChild(d);
      throw new Error(msg);
    }
    const imgs = new Map<string, HTMLImageElement>();
    await Promise.all(
      Object.keys(map.tiles).map(
        (id) => new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = `/assets/tiles/${id}.png`;
          imgs.set(id, img);
        }),
      ),
    );
    this.build(map, imgs);
  }

  /** Будує списки малювання з даних карти (окремо від завантаження — щоб перевіряти в тестах без браузера). */
  build(map: MapFile, imgs: Map<string, HTMLImageElement>): void {
    this.bounds = map.bounds;
    this.groups = map.groups.map((g) => ({ floor: g.floor, roof: g.roof === 1, back: [], stand: [] }));
    const upper: Item[] = []; // усе, що може опинитись над глядачем: поверхи 2+ і дах
    for (const p of map.placements) {
      const t = map.tiles[p[0]]!;
      const gi = p[13];
      const g = this.groups[gi]!;
      const item: Item = {
        img: imgs.get(p[0])!, x: p[1], y: p[2], w: t.w / t.frames, h: t.h,
        frames: t.frames, frameMs: t.frameMs, loop: t.loop === 1,
        flipX: (p[5] & 1) !== 0, flipY: (p[5] & 2) !== 0, pvx: p[8], pvy: p[9],
        z: p[3], ax: p[11], sy: p[12], group: gi,
        outerWall: t.kind === "wall" && t.interior === 0 && !g.roof && g.floor === 1,
        building: null,
      };
      // Дах і плоске малюються першими у своїй групі (за z, потім y); решта — разом з персонажами за y.
      if (g.roof || t.flat === 1) g.back.push(item); else g.stand.push(item);
      if (g.roof || g.floor >= 2) upper.push(item);
    }
    // Array.sort стабільний: рівні елементи лишаються в порядку файлу.
    const byZ = (a: Item, b: Item) => a.z - b.z || a.sy - b.sy;
    const byY = (a: Item, b: Item) => a.sy - b.sy || a.z - b.z;
    for (const g of this.groups) { g.back.sort(byZ); g.stand.sort(byY); }
    this.buildings = makeBuildings(upper, this.groups);
  }

  /** Малює кадр: усі групи по черзі, персонажі вставляються в список свого поверху за y. */
  draw(ctx: CanvasRenderingContext2D, v: View, now: number, viewer: Viewer, actors: Actor[]): void {
    this.fade(viewer, now);
    // Персонаж іде в найвищий поверх (не дах), що не вищий за його власний рівень.
    const floors = this.groups.filter((g) => !g.roof);
    const byGroup = new Map<Group, Actor[]>();
    for (const a of actors) {
      let target = floors[0];
      for (const g of floors) if (g.floor <= a.level) target = g;
      if (!target) continue;
      const list = byGroup.get(target);
      if (list) list.push(a); else byGroup.set(target, [a]);
    }
    for (const g of this.groups) {
      for (const it of g.back) this.drawItem(ctx, it, v, now, this.alphaOf(it, g, viewer));
      const acts = (byGroup.get(g) ?? []).sort((a, b) => a.y - b.y);
      let j = 0;
      for (const it of g.stand) {
        // Спершу ті, хто не ближчий до камери за цей тайл (рівні y: персонаж раніше, тайл над ним).
        while (j < acts.length && acts[j]!.y <= it.sy) acts[j++]!.draw();
        this.drawItem(ctx, it, v, now, this.alphaOf(it, g, viewer));
      }
      while (j < acts.length) acts[j++]!.draw();
    }
  }

  /** ?debug: точки опори (за ними сортується) всіх тайлів у кадрі. */
  drawDebug(ctx: CanvasRenderingContext2D, v: View): void {
    ctx.fillStyle = "rgba(255,230,0,0.95)";
    for (const g of this.groups) {
      for (const it of g.stand) {
        if (it.ax < v.left || it.ax > v.right || it.sy < v.top || it.sy > v.bottom) continue;
        ctx.fillRect(it.ax - 1, it.sy - 1, 3, 3);
      }
    }
  }

  /** Прозорість тайла: нижчі поверхи тьмяніють, поверхи над глядачем і дах зникають разом з будинком. */
  private alphaOf(it: Item, g: Group, viewer: Viewer): number {
    if (g.roof) return it.building ? it.building.roofAlpha : 1;
    if (g.floor > viewer.level) return it.building ? it.building.upperAlpha : 1;
    return g.floor < viewer.floor ? LOWER_FLOOR_ALPHA : 1;
  }

  /** Плавно змінює прозорість будинків: глядач усередині сліду — дах і верхні поверхи зникають. */
  private fade(viewer: Viewer, now: number): void {
    const dt = this.lastFadeTime ? Math.min(0.1, (now - this.lastFadeTime) / 1000) : 0;
    this.lastFadeTime = now;
    const step = (cur: number, target: number) => cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), FADE_PER_SEC * dt);
    for (const b of this.buildings) {
      const f = b.fp;
      const inside = f !== null && viewer.x >= f.left - FOOTPRINT_PAD && viewer.x <= f.right + FOOTPRINT_PAD
        && viewer.y >= f.top - FOOTPRINT_PAD && viewer.y <= f.bottom + FOOTPRINT_PAD;
      b.roofAlpha = step(b.roofAlpha, inside || viewer.floor >= 2 ? 0 : 1);
      b.upperAlpha = step(b.upperAlpha, inside ? 0 : 1);
    }
  }

  private drawItem(ctx: CanvasRenderingContext2D, it: Item, v: View, now: number, alpha: number): void {
    if (alpha <= 0.01) return;
    if (it.x >= v.right || it.x + it.w <= v.left || it.y >= v.bottom || it.y + it.h <= v.top) return;
    // Як у редакторі: анімація стоїть на кадрі 1, а крутиться лише з галочкою "Грати постійно".
    const frame = it.frames > 1 && it.loop ? Math.floor(now / it.frameMs) % it.frames : 0;
    if (alpha < 1) ctx.globalAlpha = alpha;
    if (it.flipX || it.flipY) {
      // Віддзеркалення навколо pivot (як у редакторі).
      ctx.save();
      ctx.translate(it.pvx, it.pvy);
      ctx.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1);
      ctx.drawImage(it.img, frame * it.w, 0, it.w, it.h, it.x - it.pvx, it.y - it.pvy, it.w, it.h);
      ctx.restore();
    } else {
      ctx.drawImage(it.img, frame * it.w, 0, it.w, it.h, it.x, it.y, it.w, it.h);
    }
    if (alpha < 1) ctx.globalAlpha = 1;
  }
}

/** Збирає тайли поверхів 2+ і даху в будинки: ті, що торкаються (з запасом), — один будинок. */
function makeBuildings(items: Item[], groups: Group[]): Building[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if (a.x - BUILDING_GAP < b.x + b.w && a.x + a.w + BUILDING_GAP > b.x && a.y - BUILDING_GAP < b.y + b.h && a.y + a.h + BUILDING_GAP > b.y) {
        parent[find(i)] = find(j);
      }
    }
  }
  const byRoot = new Map<number, Building>();
  items.forEach((it, i) => {
    const r = find(i);
    let b = byRoot.get(r);
    if (!b) {
      b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, fp: null, roofAlpha: 1, upperAlpha: 1 };
      byRoot.set(r, b);
    }
    it.building = b;
    b.left = Math.min(b.left, it.x); b.top = Math.min(b.top, it.y);
    b.right = Math.max(b.right, it.x + it.w); b.bottom = Math.max(b.bottom, it.y + it.h);
  });
  const buildings = [...byRoot.values()];
  // Слід будинку на землі — за точками опори ЗОВНІШНІХ стін першого поверху поряд.
  const walls: [number, number][] = [];
  for (const g of groups) for (const it of g.stand) if (it.outerWall) walls.push([it.ax, it.sy]);
  for (const b of buildings) {
    let l = Infinity, t = Infinity, r = -Infinity, bt = -Infinity;
    for (const [x, y] of walls) {
      if (x < b.left - FOOTPRINT_SEARCH || x > b.right + FOOTPRINT_SEARCH || y < b.top - FOOTPRINT_SEARCH || y > b.bottom + FOOTPRINT_SEARCH) continue;
      l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); bt = Math.max(bt, y);
    }
    if (l <= r) b.fp = { left: l, top: t, right: r, bottom: bt };
  }
  return buildings;
}

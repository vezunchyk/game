// ============================================================================
// client/render/MapRenderer.ts
// Малює карту з TileWeaver ТАК САМО, як редактор.
//
// Правила редактора (перенесені 1:1):
//   * позиція тайла і pivot вже пораховані скриптом build-map (x0,y0 — лівий верхній кут);
//   * порядок малювання: за z, а при рівному z — за y (стабільне сортування);
//   * віддзеркалення — навколо точки pivot.
//
// Єдине, чого в редакторі нема, — ГРАВЦІ. Тому:
//   1. Все, що нижче верхніх поверхів (z < UPPER_FLOOR_Z), малюється в порядку редактора.
//   2. Поверх малюються гравці.
//   3. Високі об'єкти першого поверху (стіни), що стоять ПЕРЕД гравцем, перемальовуються
//      поверх нього — лише в межах його спрайта. Так гравець ховається за стіною.
//   4. Верхні поверхи і дах (z >= UPPER_FLOOR_Z або isRoof) — окремою групою "верх будинку":
//      коли гравець всередині, вона плавно зникає.
// ============================================================================

/** Тайли з z >= цього значення — верхні поверхи (малюються разом з дахом). */
const UPPER_FLOOR_Z = 35;

/** Об'єкт першого поверху може закривати гравця, якщо z >= цього... */
const OCCLUDER_MIN_Z = 20;
/** ...і він ВИСОКИЙ (стіна, а не підлога): висота картинки >= цього. */
const OCCLUDER_MIN_H = 40;

/** Як швидко верх будинку зникає/з'являється (за секунду, 0..1). */
const ROOF_FADE_PER_SEC = 5;

/** Тайли ближче одне до одного ніж це (світові px) вважаються одним будинком. */
const ROOF_GROUP_GAP = 24;

interface TileInfo { w: number; h: number; px: number; py: number; frames: number; frameMs: number; loop: number; }
interface MapFile {
  format?: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  tiles: Record<string, TileInfo>;
  /** [tileId, ax, ay, z, flipX, isRoof, flipY, sortKey] — (ax, ay) = точка прив'язки тайла */
  placements: [string, number, number, number, number, number, number, number][];
}

/** Один готовий до малювання тайл. */
export interface DrawItem {
  img: HTMLImageElement;
  x: number; y: number; w: number; h: number;
  frames: number; frameMs: number; loop: boolean;
  flipX: boolean; flipY: boolean;
  /** Точка, навколо якої віддзеркалюється. */
  pvx: number; pvy: number;
  z: number;
  /** Ключ сортування редактора (p.sortY ?? p.y). */
  key: number;
  /** Ордината точки прив'язки (де об'єкт стоїть на землі) — за нею порівнюємо з гравцем. */
  anchorY: number;
}

/** Верх одного будинку: усі його тайли зникають разом, коли гравець всередині. */
interface RoofGroup {
  items: DrawItem[];
  left: number; top: number; right: number; bottom: number;
  /** Слід будинку на землі (за точками прив'язки стін першого поверху). */
  fp: { left: number; top: number; right: number; bottom: number } | null;
  alpha: number;
}

export interface View { left: number; top: number; right: number; bottom: number; }

export class MapRenderer {
  bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** Усе нижче верхніх поверхів — у порядку редактора. */
  private low: DrawItem[] = [];
  /** Високі об'єкти першого поверху (підмножина low, той самий порядок). */
  private occluders: DrawItem[] = [];
  private roofGroups: RoofGroup[] = [];
  private lastRoofTime = 0;

  async load(): Promise<void> {
    const map = (await (await fetch("/assets/map.json", { cache: "no-store" })).json()) as MapFile;
    if (map.format !== 3) {
      // Клієнт і карта з різних версій — малювати нічого, інакше вийде "каша".
      const msg = "Версії не збігаються: map.json старий (format " + map.format + "), а клієнт новий. Онови всю гру з одного архіву.";
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;inset:0;z-index:99;background:#300;color:#fff;padding:24px;font:18px sans-serif";
      d.textContent = msg;
      document.body.appendChild(d);
      throw new Error(msg);
    }
    this.bounds = map.bounds;

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

    const upperItems: DrawItem[] = [];
    const basePts: [number, number][] = [];
    for (const [id, ax, ay, z, fx, roof, fy, key] of map.placements) {
      const t = map.tiles[id]!;
      const w = t.w / t.frames;
      // Як у редакторі: лівий верхній кут = точка прив'язки - розмір * pivot, округлено.
      const x = Math.round(ax - w * t.px), y = Math.round(ay - t.h * t.py);
      const item: DrawItem = {
        img: imgs.get(id)!, x, y, w, h: t.h,
        frames: t.frames, frameMs: t.frameMs, loop: t.loop === 1,
        flipX: fx === 1, flipY: fy === 1, pvx: x + w * t.px, pvy: y + t.h * t.py, z, key, anchorY: ay,
      };
      if (roof === 1 || z >= UPPER_FLOOR_Z) upperItems.push(item);
      else {
        this.low.push(item);
        if (z >= OCCLUDER_MIN_Z && t.h >= OCCLUDER_MIN_H) { this.occluders.push(item); basePts.push([ax, ay]); }
      }
    }

    // Порядок редактора: (z, y). Array.sort стабільний — рівні елементи лишаються як у файлі.
    const byEditor = (a: DrawItem, b: DrawItem) =>
      a.z - b.z || a.key - b.key;
    this.low.sort(byEditor);
    this.occluders.sort(byEditor);

    this.roofGroups = groupRoofs(upperItems, byEditor);
    // Слід кожного будинку: бази стін першого поверху поблизу його верху.
    const M = 160;
    for (const g of this.roofGroups) {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const [x, y] of basePts) {
        if (x < g.left - M || x > g.right + M || y < g.top - M || y > g.bottom + M) continue;
        l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
      }
      if (l <= r) g.fp = { left: l, top: t, right: r, bottom: b };
    }
  }

  /** Малює карту (все, крім верху будинків) у порядку редактора. */
  drawLow(ctx: CanvasRenderingContext2D, v: View, now: number): void {
    for (const it of this.low) this.drawItem(ctx, it, v, now);
  }

  /**
   * Після того як гравця намальовано: перемальовує поверх нього стіни, що стоять ПЕРЕД ним
   * (їхня точка прив'язки нижче на екрані), лише в межах прямокутника гравця.
   */
  drawOccludersOver(ctx: CanvasRenderingContext2D, v: View, now: number, rect: View, playerY: number): void {
    let clipped = false;
    for (const it of this.occluders) {
      if (it.anchorY <= playerY) continue;
      if (it.x >= rect.right || it.x + it.w <= rect.left || it.y >= rect.bottom || it.y + it.h <= rect.top) continue;
      if (!clipped) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
        ctx.clip();
        clipped = true;
      }
      this.drawItem(ctx, it, v, now);
    }
    if (clipped) ctx.restore();
  }

  /** Верх будинків (верхні поверхи + дах) — поверх усього; над гравцем усередині плавно зникає. */
  drawRoofs(ctx: CanvasRenderingContext2D, v: View, now: number, px: number, py: number): void {
    const dt = this.lastRoofTime ? Math.min(0.1, (now - this.lastRoofTime) / 1000) : 0;
    this.lastRoofTime = now;
    for (const g of this.roofGroups) {
      const f = g.fp;
      const inside = f !== null && px >= f.left - 8 && px <= f.right + 8 && py >= f.top - 8 && py <= f.bottom + 8;
      const target = inside ? 0 : 1;
      g.alpha += Math.sign(target - g.alpha) * Math.min(Math.abs(target - g.alpha), ROOF_FADE_PER_SEC * dt);
      if (g.alpha <= 0.01) continue;
      if (g.left >= v.right || g.right <= v.left || g.top >= v.bottom || g.bottom <= v.top) continue;
      ctx.globalAlpha = g.alpha;
      for (const it of g.items) this.drawItem(ctx, it, v, now);
      ctx.globalAlpha = 1;
    }
  }

  drawItem(ctx: CanvasRenderingContext2D, it: DrawItem, v: View, now: number): void {
    if (it.x >= v.right || it.x + it.w <= v.left || it.y >= v.bottom || it.y + it.h <= v.top) return;
    // Як у редакторі: анімація стоїть на кадрі 1, а крутиться лише з галочкою "Грати постійно".
    const frame = it.frames > 1 && it.loop ? Math.floor(now / it.frameMs) % it.frames : 0;
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
  }
}

/** Збирає тайли верхніх поверхів і даху в будинки: ті, що торкаються (з запасом), — один будинок. */
function groupRoofs(items: DrawItem[], order: (a: DrawItem, b: DrawItem) => number): RoofGroup[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const gap = ROOF_GROUP_GAP;
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if (a.x - gap < b.x + b.w && a.x + a.w + gap > b.x && a.y - gap < b.y + b.h && a.y + a.h + gap > b.y) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, RoofGroup>();
  items.forEach((it, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = { items: [], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, fp: null, alpha: 1 };
      groups.set(r, g);
    }
    g.items.push(it);
    g.left = Math.min(g.left, it.x);
    g.top = Math.min(g.top, it.y);
    g.right = Math.max(g.right, it.x + it.w);
    g.bottom = Math.max(g.bottom, it.y + it.h);
  });
  for (const g of groups.values()) g.items.sort(order);
  return [...groups.values()];
}

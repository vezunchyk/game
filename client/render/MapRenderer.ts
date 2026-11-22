// ============================================================================
// client/render/MapRenderer.ts
// Малює карту з TileWeaver. Одне ядро порядку для всіх будинків:
//
//   1. ГРУПИ йдуть по черзі: земля (трава), поверх 1, поверх 2, ..., дах. Група шару задається одним рядком
//      у map-src/render-rules.json. Папки, види тайлів і «плоске» порядок НЕ вирішують.
//   2. Усередині групи тайли йдуть за z, при рівному z — за y точки опори (sy).
//   3. Персонаж сортується ТІЛЬКИ за y ніг (z на нього не діє) відносно тайлів СВОГО поверху: тайли з sy < y ніг
//      малюються до нього, решта (рівні y теж: тайл над персонажем) — після. Між собою тайли зберігають порядок (z, sy).
//   4. Перемичка над дверима отримує sy дверей/стіни, на яких висить (це робить збірка карти), тому в прорізі
//      персонаж за лінією — під нею, перед лінією — над нею. Сходи без спецправил: вони самі стоять над стіною за z і y,
//      а персонаж на них малюється в поверсі, на який піднявся (level).
//
// Будинок = група з редактора (houses у map.json). «Я в будинку» — ноги на ромбі підлоги цього будинку
// (з запасом у кілька px). Усередині: поверхи вище поточного і дах гаснуть, нижні лишаються видимими.
// ============================================================================

/** Як швидко верх будинку зникає/з'являється (за секунду, 0..1). */
const FADE_PER_SEC = 5;
/** Запас (px) навколо ромба підлоги: ноги «в будинку» трохи раніше, ніж на самому ромбі. */
const INSIDE_PAD_X = 4;
const INSIDE_PAD_Y = 3;

interface TileInfo { w: number; h: number; frames: number; frameMs: number; loop: number; }
/** floor 0 і roof 0 — земля; floor N — поверх N; roof 1 — дах. */
interface GroupInfo { floor: number; roof: number; }
/** Будинок: група з редактора. diamonds: [поверх, cx, cy, піввисота-x, піввисота-y] ромбів підлоги. */
export interface HouseInfo { name: string; diamonds: [number, number, number, number, number][]; }

/** [id, x0, y0, z, key, flags(1=flipX,2=flipY), gx, gy, pvx, pvy, axis, ax, sy, група, будинок(-1 = ніякий)] — клієнту потрібні не всі. */
export type Placement = [string, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

export interface MapFile {
  format?: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  tiles: Record<string, TileInfo>;
  groups: GroupInfo[];
  houses?: HouseInfo[];
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
  /** Точка опори: за sy сортуємо (разом з персонажами за y ніг). */
  ax: number; sy: number;
  house: House | null;
}

/** Персонаж: сортується лише за y ніг серед тайлів свого поверху. */
export interface Actor {
  x: number; y: number;
  /** Поверх, на якому він стоїть (на сходах — верхній). */
  level: number;
  draw: () => void;
}

/** Хто дивиться: його поверх, поверх для малювання (на сходах — верхній) і позиція ніг. */
export interface Viewer { x: number; y: number; floor: number; level: number; }

interface Group { floor: number; roof: boolean; items: Item[]; }

/** Будинок: прозорість кожної групи (за індексом у groups) плавно йде до цілі. */
interface House {
  name: string;
  diamonds: HouseInfo["diamonds"];
  alpha: number[];
}

export class MapRenderer {
  bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private groups: Group[] = [];
  private houses: House[] = [];
  private lastFadeTime = 0;

  async load(): Promise<void> {
    const map = (await (await fetch("/assets/map.json", { cache: "no-store" })).json()) as MapFile;
    if (map.format !== 7) {
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
    this.groups = map.groups.map((g) => ({ floor: g.floor, roof: g.roof === 1, items: [] }));
    this.houses = (map.houses ?? []).map((h) => ({ name: h.name, diamonds: h.diamonds, alpha: map.groups.map(() => 1) }));
    for (const p of map.placements) {
      const t = map.tiles[p[0]]!;
      const img = imgs.get(p[0]);
      if (!img) continue;
      this.groups[p[13]]!.items.push({
        img, x: p[1], y: p[2], w: t.w / t.frames, h: t.h,
        frames: t.frames, frameMs: t.frameMs, loop: t.loop === 1,
        flipX: (p[5] & 1) !== 0, flipY: (p[5] & 2) !== 0, pvx: p[8], pvy: p[9],
        z: p[3], ax: p[11], sy: p[12],
        house: p[14] >= 0 ? this.houses[p[14]] ?? null : null,
      });
    }
    // Array.sort стабільний: рівні елементи лишаються в порядку файлу.
    for (const g of this.groups) g.items.sort((a, b) => a.z - b.z || a.sy - b.sy);
  }

  /** Малює кадр: групи по черзі; персонаж ділить тайли свого поверху на «за ним» і «перед ним» за y ніг. */
  draw(ctx: CanvasRenderingContext2D, v: View, now: number, viewer: Viewer, actors: Actor[]): void {
    this.fade(viewer, now);
    // Персонаж іде в найвищий поверх (не землю і не дах), що не вищий за його власний рівень.
    const floorGroups = this.groups.map((g, i) => ({ g, i })).filter((e) => !e.g.roof && e.g.floor >= 1);
    const byGroup = new Map<number, Actor[]>();
    for (const a of actors) {
      let target = floorGroups[0];
      for (const e of floorGroups) if (e.g.floor <= a.level) target = e;
      if (!target) continue;
      const list = byGroup.get(target.i);
      if (list) list.push(a); else byGroup.set(target.i, [a]);
    }
    this.groups.forEach((g, gi) => {
      const acts = (byGroup.get(gi) ?? []).sort((a, b) => a.y - b.y);
      if (acts.length === 0) {
        for (const it of g.items) this.drawItem(ctx, it, v, now, this.alphaOf(it, gi));
        return;
      }
      // Тайл малюється після тих персонажів, чия y ≤ його sy (рівні — тайл над персонажем), і до решти.
      const buckets: Item[][] = Array.from({ length: acts.length + 1 }, () => []);
      for (const it of g.items) {
        if (!this.visible(it, v)) continue;
        let lo = 0, hi = acts.length; // скільки персонажів мають y ≤ it.sy
        while (lo < hi) { const mid = (lo + hi) >> 1; if (acts[mid]!.y <= it.sy) lo = mid + 1; else hi = mid; }
        buckets[lo]!.push(it);
      }
      for (let k = 0; k <= acts.length; k++) {
        for (const it of buckets[k]!) this.drawItem(ctx, it, v, now, this.alphaOf(it, gi));
        if (k < acts.length) acts[k]!.draw();
      }
    });
  }

  /** ?debug: точки опори всіх тайлів (жовті) і ромби підлоги будинків (блакитні; червоні — коли ти «в будинку»). */
  drawDebug(ctx: CanvasRenderingContext2D, v: View, viewer?: Viewer): void {
    ctx.fillStyle = "rgba(255,230,0,0.95)";
    for (const g of this.groups) {
      if (g.floor === 0 && !g.roof) continue; // трава: тисячі точок — зайве
      for (const it of g.items) {
        if (it.ax < v.left || it.ax > v.right || it.sy < v.top || it.sy > v.bottom) continue;
        ctx.fillRect(it.ax - 1, it.sy - 1, 3, 3);
      }
    }
    ctx.lineWidth = 1;
    for (const h of this.houses) {
      const inside = viewer ? this.isInside(h, viewer) : false;
      ctx.strokeStyle = inside ? "rgba(255,60,60,0.9)" : "rgba(0,200,255,0.7)";
      for (const [, cx, cy, hw, hh] of h.diamonds) {
        ctx.beginPath();
        ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy); ctx.closePath();
        ctx.stroke();
      }
    }
  }

  /** Прозорість тайла: тайли будинку гаснуть разом з будинком, решта завжди видима. */
  private alphaOf(it: Item, gi: number): number {
    return it.house ? it.house.alpha[gi] ?? 1 : 1;
  }

  /** «Я в будинку»: ноги стоять на ромбі підлоги цього будинку (свого поверху або поверху, куди піднявся). */
  private isInside(h: House, viewer: Viewer): boolean {
    for (const [f, cx, cy, hw, hh] of h.diamonds) {
      if (f !== viewer.floor && f !== viewer.level) continue;
      if (Math.abs(viewer.x - cx) / (hw + INSIDE_PAD_X) + Math.abs(viewer.y - cy) / (hh + INSIDE_PAD_Y) <= 1) return true;
    }
    return false;
  }

  /** Плавно змінює прозорість будинків: усередині — поверхи вище поточного і дах гаснуть, нижні лишаються. */
  private fade(viewer: Viewer, now: number): void {
    const dt = this.lastFadeTime ? Math.min(0.1, (now - this.lastFadeTime) / 1000) : 0;
    this.lastFadeTime = now;
    const step = (cur: number, target: number) => cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), FADE_PER_SEC * dt);
    for (const h of this.houses) {
      const inside = this.isInside(h, viewer);
      this.groups.forEach((g, gi) => {
        const hidden = inside && (g.roof || g.floor > viewer.level);
        h.alpha[gi] = step(h.alpha[gi] ?? 1, hidden ? 0 : 1);
      });
    }
  }

  private visible(it: Item, v: View): boolean {
    return !(it.x >= v.right || it.x + it.w <= v.left || it.y >= v.bottom || it.y + it.h <= v.top);
  }

  private drawItem(ctx: CanvasRenderingContext2D, it: Item, v: View, now: number, alpha: number): void {
    if (alpha <= 0.01) return;
    if (!this.visible(it, v)) return;
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

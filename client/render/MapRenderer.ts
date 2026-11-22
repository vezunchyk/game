// ============================================================================
// client/render/MapRenderer.ts
// Малює карту з TileWeaver. Порядок такий самий, як у редакторі:
//
//   ШАР -> Z -> Y
//
//   1. Групи малювання (з шарів редактора, див. map-src/render-rules.json), від нижньої до верхньої:
//        ground (трава) -> поверх 1 -> поверх 2 -> ... -> дах.
//   2. Усередині групи тайли йдуть за z, при рівному z — за y точки опори (чим нижче на екрані, тим пізніше).
//      Єдиний виняток — підлога-ромб (ground=1): вона малюється першою у своєму поверсі, бо її ніщо не закриває
//      і по ній ходять. Усе інше (стіни, сходи, перемички, бордюр) — за z і y, без правил «для цього виду».
//   3. Персонаж — у групі свого поверху. З тайлами він порівнюється лише за y ніг (z на нього не діє):
//      малюється перед першим тайлом, який його перекриває і стоїть не вище за його ноги (sy >= y).
//      Рівні y: тайл над персонажем. Персонаж на сходах має level верхнього поверху.
//
// БУДИНОК = група з редактора (напр. «б1», поле group у розміщення). «Я в будинку» = ноги стоять на ромбі підлоги
// цього будинку на моєму поверсі. Тоді поверхи вище мого і дах цього будинку гаснуть; нижні поверхи не чіпаємо.
// Тайли без групи (трава) ніколи не гаснуть і нічого не вмикають.
// ============================================================================

/** Як швидко верх будинку зникає/з'являється (за секунду, 0..1). */
const FADE_PER_SEC = 5;
/** Запас навколо ромба підлоги (світові px), щоб «в будинку» не мигало на порозі. */
const INSIDE_PAD_X = 8;
const INSIDE_PAD_Y = 4;
/** Прямокутник персонажа для перевірки «перекриває»: від ніг вгору. */
const ACTOR_HALF_W = 24;
const ACTOR_H = 64;
/** Ключ даху в прозорості будинку (вище будь-якого поверху). */
const ROOF_KEY = 1000;

interface TileInfo {
  w: number; h: number; frames: number; frameMs: number; loop: number;
  /** 1 = підлога-ромб. */
  ground?: number;
}
interface GroupInfo { floor: number; roof: number; }

/** [id, x0, y0, z, key, flags(1=flipX,2=flipY), gx, gy, pvx, pvy, axis, ax, sy, група, будинок(0 = немає, інакше номер у buildings з 1)] */
export type Placement = [string, number, number, number, number, number, number, number, number, number, number, number, number, number, number?];

export interface BuildingInfo {
  name: string;
  /** Ромби підлоги за номером поверху: [центр x, центр y, півширина, піввисота]. */
  floors: Record<string, [number, number, number, number][]>;
}

export interface MapFile {
  format?: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  tiles: Record<string, TileInfo>;
  groups: GroupInfo[];
  buildings?: BuildingInfo[];
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
  /** Точка опори: за sy сортуємо. */
  ax: number; sy: number;
  ground: boolean;
  /** Поверх тайла (0 = ground-шар, ROOF_KEY = дах); разом з building визначає, коли тайл гасне. */
  floor: number;
  building: Building | null;
}

interface Building {
  name: string;
  floors: Map<number, [number, number, number, number][]>;
  /** Поточна прозорість за ключем поверху (ROOF_KEY — дах). */
  alpha: Map<number, number>;
}

/** Група малювання: підлоги (першими) і решта (разом з персонажами). */
interface Group {
  floor: number;
  roof: boolean;
  under: Item[];
  stand: Item[];
}

/** Хто в кадрі: персонаж у цілих світових координатах (ноги) і поверх, на якому його малювати. */
export interface Actor {
  x: number; y: number;
  level: number;
  draw: () => void;
}

/** Глядач (моя камера): ноги, поверх, на якому я зараз, і рівень малювання (на сходах — верхній поверх). */
export interface Viewer { x: number; y: number; floor: number; level: number; }

export class MapRenderer {
  bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private groups: Group[] = [];
  private buildings: Building[] = [];
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
    this.groups = map.groups.map((g) => ({ floor: g.floor, roof: g.roof === 1, under: [], stand: [] }));
    this.buildings = (map.buildings ?? []).map((b) => ({
      name: b.name,
      floors: new Map<number, [number, number, number, number][]>(Object.entries(b.floors).map(([n, d]): [number, [number, number, number, number][]] => [Number(n), d])),
      alpha: new Map<number, number>(),
    }));
    for (const p of map.placements) {
      const t = map.tiles[p[0]]!;
      const g = this.groups[p[13]]!;
      const building = p[14] ? (this.buildings[p[14] - 1] ?? null) : null;
      const floor = g.roof ? ROOF_KEY : g.floor;
      const item: Item = {
        img: imgs.get(p[0])!, x: p[1], y: p[2], w: t.w / t.frames, h: t.h,
        frames: t.frames, frameMs: t.frameMs, loop: t.loop === 1,
        flipX: (p[5] & 1) !== 0, flipY: (p[5] & 2) !== 0, pvx: p[8], pvy: p[9],
        z: p[3], ax: p[11], sy: p[12], ground: t.ground === 1, floor, building,
      };
      if (building) building.alpha.set(floor, 1);
      // Нижня група (трава) і дах — просто за (z, y); у поверхах підлога йде першою.
      const underGroup = g.roof || g.floor === 0 || item.ground;
      (underGroup ? g.under : g.stand).push(item);
    }
    const byZY = (a: Item, b: Item) => a.z - b.z || a.sy - b.sy;
    for (const g of this.groups) { g.under.sort(byZY); g.stand.sort(byZY); }
  }

  /** Кадр: групи по черзі; у кожному поверсі — підлога, далі тайли й персонажі. Прозорість — за будинком. */
  draw(ctx: CanvasRenderingContext2D, v: View, now: number, viewer: Viewer, actors: Actor[]): void {
    this.fade(viewer, now);
    const floorGroups = this.groups.filter((g) => !g.roof && g.floor >= 1);
    const actorsOf = new Map<Group, Actor[]>();
    for (const a of actors) {
      // Поверх персонажа: найвища група, що не вища за його level (нижчої немає — найнижча).
      let target: Group | undefined;
      for (const g of floorGroups) if (g.floor <= a.level) target = g;
      target ??= floorGroups[0];
      if (!target) continue;
      let list = actorsOf.get(target);
      if (!list) actorsOf.set(target, (list = []));
      list.push(a);
    }

    for (const g of this.groups) {
      for (const it of g.under) this.drawItem(ctx, it, v, now);
      const acts = actorsOf.get(g);
      if (!acts) { for (const it of g.stand) this.drawItem(ctx, it, v, now); continue; }
      // Для кожного персонажа — індекс першого тайла, що його перекриває і стоїть не вище за його ноги.
      const slots = acts.map((a) => ({ a, at: this.slotOf(g.stand, a) })).sort((p, q) => p.at - q.at || p.a.y - q.a.y);
      let j = 0;
      for (let i = 0; i < g.stand.length; i++) {
        while (j < slots.length && slots[j]!.at <= i) slots[j++]!.a.draw();
        this.drawItem(ctx, g.stand[i]!, v, now);
      }
      while (j < slots.length) slots[j++]!.a.draw();
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

  /** Місце персонажа в списку: перед першим видимим тайлом, який його перекриває і має sy >= y ніг. */
  private slotOf(list: Item[], a: Actor): number {
    const left = a.x - ACTOR_HALF_W, right = a.x + ACTOR_HALF_W, top = a.y - ACTOR_H, bottom = a.y;
    for (let i = 0; i < list.length; i++) {
      const it = list[i]!;
      if (it.sy < a.y) continue;
      if (it.x >= right || it.x + it.w <= left || it.y >= bottom || it.y + it.h <= top) continue;
      if (this.alphaOf(it) <= 0.01) continue;
      return i;
    }
    return list.length;
  }

  /** Прозорість тайла: лише тайли будинку (з групою), і лише ті, що вище за мій поверх або дах. */
  private alphaOf(it: Item): number {
    return it.building ? (it.building.alpha.get(it.floor) ?? 1) : 1;
  }

  /** Плавно змінює прозорість будинків: я на ромбі підлоги будинку — поверхи вище мого поверху і дах гаснуть. */
  private fade(viewer: Viewer, now: number): void {
    const dt = this.lastFadeTime ? Math.min(0.1, (now - this.lastFadeTime) / 1000) : 0;
    this.lastFadeTime = now;
    const step = (cur: number, target: number) => cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), FADE_PER_SEC * dt);
    for (const b of this.buildings) {
      const inside = (b.floors.get(viewer.floor) ?? []).some(([cx, cy, hw, hh]) =>
        Math.abs(viewer.x - cx) / (hw + INSIDE_PAD_X) + Math.abs(viewer.y - cy) / (hh + INSIDE_PAD_Y) <= 1);
      for (const [key, cur] of b.alpha) b.alpha.set(key, step(cur, inside && key > viewer.floor ? 0 : 1));
    }
  }

  private drawItem(ctx: CanvasRenderingContext2D, it: Item, v: View, now: number): void {
    const alpha = this.alphaOf(it);
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

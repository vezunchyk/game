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

/**
 * ПРАВИЛА МАЛЮВАННЯ ОБ'ЄКТІВ. Папка тайла в редакторі -> назва правила (map-src/render-rules.json),
 * тут — що це правило означає. Новий вид об'єкта (дверна балка, навіс, ...) = запис тут
 * і рядок у render-rules.json; решту коду чіпати не треба.
 *   occludes — об'єкт перемальовується ПОВЕРХ гравця, коли той стоїть вище якоря об'єкта
 *              (гравець перед об'єктом — малюється поверх нього, за ним — під ним);
 *   anyHeight — для occludes: не вимагати високої картинки (тонка балка теж перекриває);
 *   inFootprint — якір враховується в слід будинку (де зникає дах).
 */
const TILE_RULES: Record<string, { occludes: boolean; anyHeight: boolean; inFootprint: boolean; axis?: "L" | "R" }> = {
  overlay: { occludes: true, anyHeight: true, inFootprint: false },
  // Стіни вздовж осей ізометрії. Глибину міряємо ВЛАСНОЮ віссю стіни, а не просто y:
  //   wallL — стіна йде знизу-ліворуч угору-праворуч (папка "Ліво"), її глибина t = y + x/2;
  //   wallR — стіна йде згори-ліворуч униз-праворуч (папка "право"), її глибина s = y - x/2.
  // Інакше сегмент стіни збоку від гравця (він нижче на екрані) помилково перекриває гравця,
  // що стоїть впритул до стіни.
  wallL: { occludes: true, anyHeight: false, inFootprint: true, axis: "L" },
  wallR: { occludes: true, anyHeight: false, inFootprint: true, axis: "R" },
};

/** Тег з редактора: балка над головою. Гравець у будинку (на поверсі 1) ЗАВЖДИ під нею. */
const BEAM_TAG = "Балка";
/** Тег з редактора: сходи між поверхами. */
const STAIRS_TAG = "Сходи";

/** Прозорість першого поверху, коли гравець на поверсі 2+. */
const LOWER_FLOOR_ALPHA = 0.3;

/** Тайли ближче одне до одного ніж це (світові px) вважаються одним будинком. */
const ROOF_GROUP_GAP = 24;

interface TileInfo { rule?: string; w: number; h: number; px: number; py: number; frames: number; frameMs: number; loop: number; }
interface MapFile {
  format?: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  tiles: Record<string, TileInfo>;
  /** [tileId, x0, y0, z, sortKey, flags(1=flipX,2=flipY,4=roof,>>3=поверх), ax, ay, pvx, pvy, tag] */
  placements: [string, number, number, number, number, number, number, number, number, number, string][];
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
  /** Абсциса точки прив'язки (для глибини вздовж осей ізометрії). */
  anchorX: number;
  /** Поверх тайла (0 — земля/декор без поверху). */
  floor: number;
  isRoof: boolean;
  /** Правило малювання з папки тайла (див. TILE_RULES). */
  rule: string;
  /** Тег тайла з редактора (напр. "Балка"), порожній — нема. */
  tag: string;
}

/** Верх одного будинку: усі його тайли зникають разом, коли гравець всередині. */
interface RoofGroup {
  items: DrawItem[];
  left: number; top: number; right: number; bottom: number;
  /** Слід будинку на землі (за точками прив'язки стін першого поверху). */
  fp: { left: number; top: number; right: number; bottom: number } | null;
  /** Прозорість даху (isRoof/z>=35) і стін верхніх поверхів — окремо. */
  alpha: number;
  alphaWalls: number;
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
    for (const [id, x, y, z, key, flags, ax, ay, pvx, pvy, tag] of map.placements) {
      const t = map.tiles[id]!;
      const item: DrawItem = {
        img: imgs.get(id)!, x, y, w: t.w / t.frames, h: t.h,
        frames: t.frames, frameMs: t.frameMs, loop: t.loop === 1,
        flipX: (flags & 1) !== 0, flipY: (flags & 2) !== 0, pvx, pvy, z, key, anchorY: ay, anchorX: ax,
        floor: flags >> 3, isRoof: (flags & 4) !== 0 || z >= UPPER_FLOOR_Z, rule: t.rule ?? "", tag: tag ?? "",
      };
      // Верх будинку: дах і все, що належить поверху 2+ (за полем floor з редактора).
      if (item.isRoof || item.floor >= 2) upperItems.push(item);
      else {
        this.low.push(item);
        // Стіна першого поверху (високий тайл): може закривати гравця. Без поля floor — старе правило за z.
        const wall = item.floor === 1 || (item.floor === 0 && z >= OCCLUDER_MIN_Z);
        const rule = TILE_RULES[item.rule];
        if (rule?.occludes && (rule.anyHeight || t.h >= OCCLUDER_MIN_H)) {
          this.occluders.push(item);
          if (rule.inFootprint) basePts.push([ax, ay]);
        } else if (item.tag === BEAM_TAG) {
          // Балка першого поверху: перекриває гравця, коли той у будинку (див. drawOccludersOver).
          // У слід будинку НЕ входить — слід рахуємо лише за стінами.
          this.occluders.push(item);
          if (wall && t.h >= OCCLUDER_MIN_H) basePts.push([ax, ay]);
        } else if (wall && t.h >= OCCLUDER_MIN_H) { this.occluders.push(item); basePts.push([ax, ay]); }
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
  drawLow(ctx: CanvasRenderingContext2D, v: View, now: number, playerFloor = 1): void {
    // Гравець на поверсі 2+: перший поверх будинку (стіни/підлога з floor=1) напівпрозорий.
    for (const it of this.low) {
      // Сходи не напівпрозорі: по них гравець якраз піднімається на поверх 2.
      if (playerFloor >= 2 && it.floor === 1 && it.tag !== STAIRS_TAG) {
        ctx.globalAlpha = LOWER_FLOOR_ALPHA;
        this.drawItem(ctx, it, v, now);
        ctx.globalAlpha = 1;
      } else this.drawItem(ctx, it, v, now);
    }
  }

  /**
   * Після того як гравця намальовано: перемальовує поверх нього стіни, що стоять ПЕРЕД ним
   * (їхня точка прив'язки нижче на екрані), лише в межах прямокутника гравця.
   */
  drawOccludersOver(ctx: CanvasRenderingContext2D, v: View, now: number, rect: View, playerX: number, playerY: number, playerFloor = 1): void {
    // Гравець у сліді будинку на поверсі 1 — балки завжди над ним (він під ними).
    const underBeams = playerFloor < 2 && this.insideHouse(playerX, playerY);
    let clipped = false;
    for (const it of this.occluders) {
      const beamOverPlayer = underBeams && it.tag === BEAM_TAG;
      if (!beamOverPlayer && !isInFront(it, playerX, playerY)) continue;
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

  /** Чи стоїть точка у сліді якогось будинку (той самий слід, що ховає дах). */
  private insideHouse(px: number, py: number): boolean {
    for (const g of this.roofGroups) {
      const f = g.fp;
      if (f && px >= f.left - 8 && px <= f.right + 8 && py >= f.top - 8 && py <= f.bottom + 8) return true;
    }
    return false;
  }

  /** Верх будинків (верхні поверхи + дах) — поверх усього; над гравцем усередині плавно зникає. */
  drawRoofs(ctx: CanvasRenderingContext2D, v: View, now: number, px: number, py: number, playerFloor = 1): void {
    const dt = this.lastRoofTime ? Math.min(0.1, (now - this.lastRoofTime) / 1000) : 0;
    this.lastRoofTime = now;
    const step = (cur: number, target: number) => cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), ROOF_FADE_PER_SEC * dt);
    for (const g of this.roofGroups) {
      const f = g.fp;
      const inside = f !== null && px >= f.left - 8 && px <= f.right + 8 && py >= f.top - 8 && py <= f.bottom + 8;
      // Дах: зникає, коли гравець усередині сліду або на поверсі 2+.
      g.alpha = step(g.alpha, inside || playerFloor >= 2 ? 0 : 1);
      // Стіни поверху 2+: зникають, коли гравець усередині на поверсі 1 (він під ними). На поверсі 2+ — видно.
      g.alphaWalls = step(g.alphaWalls, inside && playerFloor < 2 ? 0 : 1);
      if (g.alpha <= 0.01 && g.alphaWalls <= 0.01) continue;
      if (g.left >= v.right || g.right <= v.left || g.top >= v.bottom || g.bottom <= v.top) continue;
      for (const it of g.items) {
        const a = it.isRoof ? g.alpha : g.alphaWalls;
        if (a <= 0.01) continue;
        ctx.globalAlpha = a;
        this.drawItem(ctx, it, v, now);
      }
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

/** Чи стоїть об'єкт ПЕРЕД гравцем (ближче до камери) — за віссю самого об'єкта. */
function isInFront(it: DrawItem, px: number, py: number): boolean {
  const axis = TILE_RULES[it.rule]?.axis;
  if (axis === "L") return it.anchorY + it.anchorX / 2 > py + px / 2;
  if (axis === "R") return it.anchorY - it.anchorX / 2 > py - px / 2;
  return it.anchorY > py;
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
      g = { items: [], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, fp: null, alpha: 1, alphaWalls: 1 };
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

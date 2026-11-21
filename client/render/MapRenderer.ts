// ============================================================================
// client/render/MapRenderer.ts
// Малює карту з TileWeaver. ОДНА система для всіх будинків (див. специфікацію «Система карти»).
//
// Звідки береться поведінка тайла:
//   * ВИД (kind) — з папки тайла в редакторі, збірка карти кладе його в map.json (map-src/folder-kinds.json);
//   * напрям стіни (axis: 1 = L, 2 = R, 0 = кут/невідомо) — з форми картинки (збірка теж);
//   * поверх (floor) і позначка «Дах» — з розміщення в редакторі.
// Тут немає жодних винятків «для цього будинку»: лише таблиця KIND_LAYER і одне правило глибини.
//
// Порядок кадру (малює main.ts):
//   1. drawBase     — усе, що НИЖЧЕ або НА рівні глядача (плоске і вертикальне, в порядку редактора);
//   2. персонаж, а поверх нього drawOver — вертикальне, що стоїть ПЕРЕД ним (лише в межах спрайта);
//   3. drawUpper    — дах і те, що ВИЩЕ глядача; над глядачем усередині будинку плавно зникає.
// ============================================================================

/** Як швидко верх будинку зникає/з'являється (за секунду, 0..1). */
const ROOF_FADE_PER_SEC = 5;
/** Прозорість нижчих поверхів, коли глядач на поверсі 2+. */
const LOWER_FLOOR_ALPHA = 0.3;
/** Тайли ближче одне до одного ніж це (світові px) вважаються одним будинком. */
const ROOF_GROUP_GAP = 24;
/**
 * Допуск (px) глибини: колізії стін можуть пускати гравця на кілька px «за» лінію основи стіни.
 * Без допуску така стіна накрила б його цілком.
 */
const DEPTH_TOL = 6;
/** Наскільки глибоко в товщу стіни (px) гравець ще «під балкою» над проходом. */
const BEAM_DEPTH = 14;

/**
 * Шар малювання за видом тайла:
 *   flat     — під персонажем завжди (підлога, сходи, рельєф);
 *   vertical — сортується за глибиною відносно персонажа (стіни, двері, огорожа, стовпи, предмети...);
 *   roof     — після персонажів, ховається над глядачем.
 * Новий вид тайла = рядок тут (+ рядок у map-src/folder-kinds.json).
 */
type Layer = "flat" | "vertical" | "roof";
const KIND_LAYER: Record<string, Layer> = {
  floor: "flat", stairs: "flat", relief: "flat",
  wall: "vertical", trim: "vertical", beam: "vertical", door_frame: "vertical", door: "vertical",
  fence: "vertical", pillar: "vertical", prop: "vertical",
  roof: "roof",
};

interface TileInfo { kind: string; interior: number; w: number; h: number; px: number; py: number; frames: number; frameMs: number; loop: number; }
export interface MapFile {
  format?: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  tiles: Record<string, TileInfo>;
  /** [tileId, x0, y0, z, sortKey, flags(1=flipX,2=flipY,4=roof,>>3=поверх), ax, ay, pvx, pvy, axis(0=?,1=L,2=R)] */
  placements: [string, number, number, number, number, number, number, number, number, number, number][];
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
  /** Точка прив'язки (де об'єкт стоїть на землі) — за нею рахується глибина. */
  anchorX: number; anchorY: number;
  /** Поверх з редактора (0 — не прив'язаний: земля/декор). */
  floor: number;
  /** Рівень для порядку малювання: поверх, але 0 -> 1 (земля лежить на першому рівні). */
  level: number;
  kind: string;
  layer: Layer;
  interior: boolean;
  /** Напрям стіни: 1 = L, 2 = R, 0 = кут/невідомо. */
  axis: number;
}

/** Верх одного будинку: усі його тайли зникають разом, коли гравець всередині. */
interface RoofGroup {
  items: DrawItem[];
  left: number; top: number; right: number; bottom: number;
  /** Слід будинку на землі (за точками прив'язки ЗОВНІШНІХ стін). */
  fp: { left: number; top: number; right: number; bottom: number } | null;
  alpha: number;      // дах
  alphaWalls: number; // стіни/підлога верхніх поверхів
}

export interface View { left: number; top: number; right: number; bottom: number; }

export class MapRenderer {
  /** ?debug: що саме перемальовано поверх гравця в цьому кадрі (для діагностики порядку малювання). */
  debugMarks: { x: number; y: number; w: number; h: number; label: string; beam: boolean }[] = [];
  bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** Не-дахові тайли за рівнями, у порядку редактора. */
  private levels = new Map<number, { base: DrawItem[]; vertical: DrawItem[] }>();
  private levelOrder: number[] = [];
  private roofGroups: RoofGroup[] = [];
  private lastRoofTime = 0;

  async load(): Promise<void> {
    const map = (await (await fetch("/assets/map.json", { cache: "no-store" })).json()) as MapFile;
    if (map.format !== 5) {
      // Клієнт і карта з різних версій — малювати нічого, інакше вийде "каша".
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

  /** Будує структури малювання з даних карти (окремо від завантаження — щоб перевіряти в тестах без браузера). */
  build(map: MapFile, imgs: Map<string, HTMLImageElement>): void {
    this.bounds = map.bounds;
    const upper: DrawItem[] = []; // дах + усе, що може опинитись над глядачем
    const footprint: [number, number][] = [];
    for (const [id, x, y, z, key, flags, ax, ay, pvx, pvy, axis] of map.placements) {
      const t = map.tiles[id]!;
      const floor = flags >> 3;
      const isRoof = (flags & 4) !== 0 || t.kind === "roof"; // позначка «Дах» з редактора перебиває папку
      const item: DrawItem = {
        img: imgs.get(id)!, x, y, w: t.w / t.frames, h: t.h,
        frames: t.frames, frameMs: t.frameMs, loop: t.loop === 1,
        flipX: (flags & 1) !== 0, flipY: (flags & 2) !== 0, pvx, pvy, z, key, anchorX: ax, anchorY: ay,
        floor, level: Math.max(1, floor), kind: t.kind, layer: isRoof ? "roof" : KIND_LAYER[t.kind] ?? "flat",
        interior: t.interior === 1, axis: axis ?? 0,
      };
      if (item.layer === "roof" || item.level >= 2) upper.push(item);
      if (item.layer !== "roof") {
        let lv = this.levels.get(item.level);
        if (!lv) this.levels.set(item.level, (lv = { base: [], vertical: [] }));
        lv.base.push(item);
        if (item.layer === "vertical") lv.vertical.push(item);
      }
      // Слід будинку задають ЗОВНІШНІ стіни першого рівня (внутрішні всередині нічого не міняють).
      if (item.kind === "wall" && !item.interior && item.level === 1) footprint.push([ax, ay]);
    }

    // Порядок редактора: (z, y). Array.sort стабільний — рівні елементи лишаються як у файлі.
    const byEditor = (a: DrawItem, b: DrawItem) => a.z - b.z || a.key - b.key;
    for (const lv of this.levels.values()) { lv.base.sort(byEditor); lv.vertical.sort(byEditor); }
    this.levelOrder = [...this.levels.keys()].sort((a, b) => a - b);

    this.roofGroups = groupRoofs(upper, byEditor);
    const M = 160;
    for (const g of this.roofGroups) {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const [x, y] of footprint) {
        if (x < g.left - M || x > g.right + M || y < g.top - M || y > g.bottom + M) continue;
        l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
      }
      if (l <= r) g.fp = { left: l, top: t, right: r, bottom: b };
    }
  }

  /**
   * Усе, що на рівні глядача або нижче. drawLevel — рівень, на якому глядач «стоїть» для порядку малювання
   * (на сходах — верхній поверх сходів), floor — його справжній поверх (від нього залежить затемнення нижчих).
   */
  drawBase(ctx: CanvasRenderingContext2D, v: View, now: number, floor: number, drawLevel: number): void {
    for (const lvl of this.levelOrder) {
      if (lvl > drawLevel) break;
      for (const it of this.levels.get(lvl)!.base) {
        if (isDimmed(it, floor)) {
          ctx.globalAlpha = LOWER_FLOOR_ALPHA;
          this.drawItem(ctx, it, v, now);
          ctx.globalAlpha = 1;
        } else this.drawItem(ctx, it, v, now);
      }
    }
  }

  /**
   * Після персонажа: перемальовує поверх нього вертикальні об'єкти його рівня, що стоять ПЕРЕД ним,
   * лише в межах прямокутника спрайта. Балка — також, коли персонаж у прорізі під нею.
   *   charLevel — рівень персонажа; viewerLevel/viewerFloor — рівень і поверх глядача (для затемнення).
   */
  drawOver(
    ctx: CanvasRenderingContext2D, v: View, now: number, rect: View, px: number, py: number,
    charLevel: number, viewerLevel: number, viewerFloor: number,
  ): void {
    // Персонаж вище за глядача: його перекриває верх будинку, який малює drawUpper.
    if (charLevel > viewerLevel) return;
    const list = this.levels.get(charLevel)?.vertical;
    if (!list) return;
    let clipped = false;
    for (const it of list) {
      if (it.x >= rect.right || it.x + it.w <= rect.left || it.y >= rect.bottom || it.y + it.h <= rect.top) continue; // не заходить у спрайт
      const beamOver = it.kind === "beam" && isUnderBeam(it, px, py);
      if (!beamOver && !isInFront(it, px, py)) continue;
      this.debugMarks.push({ x: it.x, y: it.y, w: it.w, h: it.h, beam: beamOver, label: `${it.kind}${it.interior ? "/внутр" : ""} ax${it.axis} f${it.floor} @${Math.round(it.anchorX)},${Math.round(it.anchorY)}` });
      if (!clipped) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
        ctx.clip();
        clipped = true;
      }
      if (isDimmed(it, viewerFloor)) ctx.globalAlpha = LOWER_FLOOR_ALPHA;
      this.drawItem(ctx, it, v, now);
      ctx.globalAlpha = 1;
    }
    if (clipped) ctx.restore();
  }

  /** Дах і те, що ВИЩЕ глядача — поверх усього; над глядачем усередині будинку плавно зникає. */
  drawUpper(ctx: CanvasRenderingContext2D, v: View, now: number, px: number, py: number, floor: number, drawLevel: number): void {
    const dt = this.lastRoofTime ? Math.min(0.1, (now - this.lastRoofTime) / 1000) : 0;
    this.lastRoofTime = now;
    const step = (cur: number, target: number) => cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), ROOF_FADE_PER_SEC * dt);
    for (const g of this.roofGroups) {
      const f = g.fp;
      const inside = f !== null && px >= f.left - 8 && px <= f.right + 8 && py >= f.top - 8 && py <= f.bottom + 8;
      // Дах: зникає, коли глядач усередині сліду або на поверсі 2+. Поверхи над глядачем: зникають, коли він усередині.
      g.alpha = step(g.alpha, inside || floor >= 2 ? 0 : 1);
      g.alphaWalls = step(g.alphaWalls, inside ? 0 : 1);
      if (g.alpha <= 0.01 && g.alphaWalls <= 0.01) continue;
      if (g.left >= v.right || g.right <= v.left || g.top >= v.bottom || g.bottom <= v.top) continue;
      for (const it of g.items) {
        const isRoof = it.layer === "roof";
        if (!isRoof && it.level <= drawLevel) continue; // рівень глядача і нижчі вже намальовано в drawBase
        const a = isRoof ? g.alpha : g.alphaWalls;
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

/** Нижчий за глядача поверх будинку тьмяніє (земля, не прив'язана до поверху, і сходи — ні). */
function isDimmed(it: DrawItem, viewerFloor: number): boolean {
  return it.floor >= 1 && it.floor < viewerFloor && it.kind !== "stairs";
}

/**
 * Глибина в ізометрії: t = y + x/2 стала вздовж стіни осі L, s = y - x/2 — вздовж стіни осі R.
 * Більше значення = ближче до камери.
 */
const depthT = (x: number, y: number): number => y + x / 2;
const depthS = (x: number, y: number): number => y - x / 2;

/**
 * ЄДИНЕ ПРАВИЛО: чи стоїть об'єкт ПЕРЕД гравцем (ближче до камери).
 *  - вісь L / R: порівнюємо глибину ВЛАСНОЮ віссю об'єкта (стіни, двері, огорожа, бордюр...);
 *  - вісь невідома (кути, стовпи, предмети): ближче за ОБОМА осями (конус знизу).
 */
function isInFront(it: DrawItem, px: number, py: number): boolean {
  const t = depthT(it.anchorX, it.anchorY) > depthT(px, py) + DEPTH_TOL;
  const s = depthS(it.anchorX, it.anchorY) > depthS(px, py) + DEPTH_TOL;
  return it.axis === 1 ? t : it.axis === 2 ? s : t && s;
}

/** Чи стоїть гравець ПІД балкою: у межах її довжини вздовж стіни і в товщині стіни (BEAM_DEPTH). */
function isUnderBeam(it: DrawItem, px: number, py: number): boolean {
  const half = it.w / 2 + 2;
  if (it.axis === 1) return Math.abs(depthT(px, py) - depthT(it.anchorX, it.anchorY)) <= BEAM_DEPTH && Math.abs(depthS(px, py) - depthS(it.anchorX, it.anchorY)) <= half;
  if (it.axis === 2) return Math.abs(depthS(px, py) - depthS(it.anchorX, it.anchorY)) <= BEAM_DEPTH && Math.abs(depthT(px, py) - depthT(it.anchorX, it.anchorY)) <= half;
  return Math.abs(px - it.anchorX) <= half && Math.abs(py - it.anchorY) <= BEAM_DEPTH / 2;
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

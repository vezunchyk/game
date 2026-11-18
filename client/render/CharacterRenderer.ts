// ============================================================================
// client/render/CharacterRenderer.ts
// Малює персонажів зі спрайт-листа spritesheet.png (кадр 48x64, 6 кадрів, 5 рядів).
// Напрямок і "іде/стоїть" визначає СЕРВЕР; тут лише вибір потрібного кадру.
// ============================================================================
import { Dir, SPRITE_FRAMES, SPRITE_H, SPRITE_W } from "../../shared/constants.js";
import type { PlayerState } from "../../shared/protocol.js";

/**
 * Який рядок спрайт-листа і чи віддзеркалювати — для кожного з 8 напрямків.
 * Припущення: у листі персонаж у рядках 1, 3, 4 дивиться ВПРАВО.
 * Якщо в грі бокові напрямки переплутані — міняємо `flip` ТУТ, в одному місці.
 *  рядок 0 — до нас (S), 1 — 3/4 спереду, 2 — спиною (N), 3 — 3/4 ззаду, 4 — збоку
 */
const DIR_SPRITE: Record<number, { row: number; flip: boolean }> = {
  [Dir.S]: { row: 0, flip: false },
  [Dir.SE]: { row: 1, flip: false },
  [Dir.E]: { row: 4, flip: false },
  [Dir.NE]: { row: 3, flip: false },
  [Dir.N]: { row: 2, flip: false },
  [Dir.NW]: { row: 3, flip: true },
  [Dir.W]: { row: 4, flip: true },
  [Dir.SW]: { row: 1, flip: true },
};

const WALK_FPS = 10;
/**
 * Скільки пікселів кадру знизу «зайве» відносно ніг (щоб ноги стояли саме в точці гравця).
 * У поточному спрайт-листі низ підошв — на 62-му рядку з 64 (кадр 0..63), тож підошва на 2 px вище краю кадру:
 * dy = y - SPRITE_H + FEET_OFFSET ставить низ підошви на y-2, як і раніше. Змінюєш лист — перевір це число.
 */
const FEET_OFFSET = 0;

export class CharacterRenderer {
  private sheet = new Image();

  load(): Promise<void> {
    return new Promise((resolve) => {
      this.sheet.onload = () => resolve();
      this.sheet.src = "/assets/spritesheet.png";
    });
  }

  draw(ctx: CanvasRenderingContext2D, p: PlayerState, now: number, isMe: boolean): void {
    const spr = DIR_SPRITE[p.dir] ?? DIR_SPRITE[Dir.S]!;
    const frame = p.mv ? Math.floor((now / 1000) * WALK_FPS) % SPRITE_FRAMES : 0;
    // Усе (тінь, спрайт, нік) прив'язане до ОДНІЄЇ цілої точки, щоб не було мікрозсувів.
    const px = Math.round(p.x);
    const py = Math.round(p.y);
    const dx = px - SPRITE_W / 2;
    const dy = py - SPRITE_H + FEET_OFFSET;

    // Тінь під ногами
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(px, py, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    if (spr.flip) {
      ctx.save();
      ctx.translate(dx + SPRITE_W, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(this.sheet, frame * SPRITE_W, spr.row * SPRITE_H, SPRITE_W, SPRITE_H, 0, 0, SPRITE_W, SPRITE_H);
      ctx.restore();
    } else {
      ctx.drawImage(this.sheet, frame * SPRITE_W, spr.row * SPRITE_H, SPRITE_W, SPRITE_H, dx, dy, SPRITE_W, SPRITE_H);
    }

    // Нік над головою
    ctx.font = "8px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = isMe ? "#b8e986" : "#e8e8e8";
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 2;
    ctx.strokeText(p.nick, px, dy - 2);
    ctx.fillText(p.nick, px, dy - 2);
  }
}

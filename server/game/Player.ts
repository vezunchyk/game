// ============================================================================
// server/game/Player.ts
// Один гравець у світі. Тут ТІЛЬКИ дані; логіка руху — в Movement.ts.
// ============================================================================
import { Dir } from "../../shared/constants.js";

export class Player {
  /** Позиція ніг у світових (екранних) координатах. Змінює ТІЛЬКИ сервер. */
  x: number;
  y: number;
  dir: number = Dir.S;
  moving = false;

  /** Останній намір від клієнта (вже очищений від сміття). Це СТАН, не команда. */
  inputX = 0;
  inputY = 0;
  /** Коли прийшов останній input (для автоматичної зупинки, якщо зв'язок пропав). */
  inputAt = 0;

  constructor(
    public readonly id: number,
    public readonly nick: string,
    x: number,
    y: number,
  ) {
    this.x = x;
    this.y = y;
  }
}

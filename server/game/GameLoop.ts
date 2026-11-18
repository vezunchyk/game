// ============================================================================
// server/game/GameLoop.ts
// Ігровий цикл із ФІКСОВАНИМ кроком. Навіть якщо сервер "підвис" на мить,
// світ наздоганяє рівно стільки тіків, скільки пропущено — швидкість гри
// не залежить від навантаження сервера.
// ============================================================================
import { TICK_DT } from "../../shared/constants.js";

export class GameLoop {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private acc = 0;

  constructor(private readonly onTick: (now: number) => void) {}

  start(): void {
    this.last = performance.now();
    this.timer = setInterval(() => this.pump(), 5);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Скільки тіків пора виконати (з обмеженням, щоб не піти в "спіраль смерті"). */
  private pump(): void {
    const now = performance.now();
    this.acc += (now - this.last) / 1000;
    this.last = now;
    let guard = 5;
    while (this.acc >= TICK_DT && guard-- > 0) {
      this.acc -= TICK_DT;
      this.onTick(Date.now());
    }
    if (guard <= 0) this.acc = 0; // відстали надто сильно — скидаємо борг
  }
}

// ============================================================================
// client/input/Keyboard.ts
// WASD / стрілки. Дає вектор -1..1. Діагональ НЕ нормалізуємо тут: сервер
// сам обмежує довжину до 1, тож подвійної швидкості на діагоналі не буде.
// ============================================================================

export class Keyboard {
  private down = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.down.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.down.delete(e.code));
    window.addEventListener("blur", () => this.down.clear());
  }

  /** Вектор напрямку. Різні клавіші одного напрямку (W і стрілка вгору) НЕ складаються. */
  get vector(): { x: number; y: number } {
    const d = this.down;
    const left = d.has("KeyA") || d.has("ArrowLeft");
    const right = d.has("KeyD") || d.has("ArrowRight");
    const up = d.has("KeyW") || d.has("ArrowUp");
    const downK = d.has("KeyS") || d.has("ArrowDown");
    return { x: (right ? 1 : 0) - (left ? 1 : 0), y: (downK ? 1 : 0) - (up ? 1 : 0) };
  }
}

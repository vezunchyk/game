// ============================================================================
// client/input/Joystick.ts
// Віртуальний джойстик для телефону.
// Захист від подвійних натискань: відстежується ОДИН палець (pointerId);
// інші дотики поки джойстик активний ігноруються.
// ============================================================================

export class Joystick {
  /** Поточний нахил, довжина 0..1. */
  x = 0;
  y = 0;
  active = false;

  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private readonly radius = 56; // на скільки px треба відтягнути до максимуму

  private base: HTMLElement;
  private knob: HTMLElement;

  constructor(private zone: HTMLElement) {
    this.base = zone.querySelector(".joy-base") as HTMLElement;
    this.knob = zone.querySelector(".joy-knob") as HTMLElement;
    zone.addEventListener("pointerdown", (e) => this.down(e));
    zone.addEventListener("pointermove", (e) => this.move(e));
    zone.addEventListener("pointerup", (e) => this.up(e));
    zone.addEventListener("pointercancel", (e) => this.up(e));
    zone.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private down(e: PointerEvent): void {
    if (this.pointerId !== null) return; // уже тримаємо інший палець
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    this.active = true;
    // Джойстик "плаваючий": центр там, де торкнувся
    const r = this.zone.getBoundingClientRect();
    this.originX = e.clientX - r.left;
    this.originY = e.clientY - r.top;
    this.base.style.left = `${this.originX}px`;
    this.base.style.top = `${this.originY}px`;
    this.base.style.opacity = "1";
    this.move(e);
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    const r = this.zone.getBoundingClientRect();
    let dx = e.clientX - r.left - this.originX;
    let dy = e.clientY - r.top - this.originY;
    const len = Math.hypot(dx, dy);
    if (len > this.radius) { dx = (dx / len) * this.radius; dy = (dy / len) * this.radius; }
    this.x = dx / this.radius;
    this.y = dy / this.radius;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = "translate(0,0)";
    this.base.style.opacity = "0.35";
  }
}

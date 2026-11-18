// ============================================================================
// client/input/InputController.ts
// Зводить джойстик і клавіатуру в ОДИН вектор наміру та шле його серверу.
//  - Джойстик має пріоритет над клавіатурою (вони НІКОЛИ не додаються).
//  - Шлемо лише коли вектор змінився + нагадуємо раз на 200 мс, поки рухаємось.
// ============================================================================
import type { Connection } from "../net/Connection.js";
import type { Joystick } from "./Joystick.js";
import type { Keyboard } from "./Keyboard.js";

const SEND_INTERVAL_MS = 50; // не частіше 20 разів/с
const KEEPALIVE_MS = 200; // поки рухаємось — повторюємо, щоб сервер не вважав, що ми відпустили

export class InputController {
  private lastX = 0;
  private lastY = 0;
  private lastSent = 0;

  constructor(private conn: Connection, private joy: Joystick, private kb: Keyboard) {}

  /** Викликається кожен кадр. */
  update(): void {
    const v = this.joy.active ? { x: this.joy.x, y: this.joy.y } : this.kb.vector;
    // Округлюємо, щоб дрібний тремор пальця не спамив мережу
    const x = Math.round(v.x * 20) / 20;
    const y = Math.round(v.y * 20) / 20;
    const now = performance.now();
    const changed = x !== this.lastX || y !== this.lastY;
    const moving = x !== 0 || y !== 0;
    if (now - this.lastSent < SEND_INTERVAL_MS) return;
    if (changed || (moving && now - this.lastSent >= KEEPALIVE_MS)) {
      this.conn.send({ t: "input", dx: x, dy: y });
      this.lastX = x; this.lastY = y; this.lastSent = now;
    }
  }
}

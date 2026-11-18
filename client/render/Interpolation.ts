// ============================================================================
// client/render/Interpolation.ts
// Плавне відображення. Сервер шле знімки 20 раз/с; ми малюємо світ із
// затримкою ~100 мс і інтерполюємо між двома знімками. Це і є "клієнт тільки
// малює": ніякої власної фізики, лише згладжування того, що вирішив сервер.
// ============================================================================
import type { MsgSnapshot, PlayerState } from "../../shared/protocol.js";

const RENDER_DELAY_MS = 100;
const MAX_BUFFER = 20;

interface Stamped { time: number; players: Map<number, PlayerState>; }

export class Interpolation {
  private buf: Stamped[] = [];

  push(snap: MsgSnapshot): void {
    const m = new Map<number, PlayerState>();
    for (const p of snap.players) m.set(p.id, p);
    this.buf.push({ time: performance.now(), players: m });
    if (this.buf.length > MAX_BUFFER) this.buf.shift();
  }

  /** Стан усіх гравців на момент "зараз - затримка". */
  sample(): PlayerState[] {
    if (this.buf.length === 0) return [];
    const t = performance.now() - RENDER_DELAY_MS;
    let a = this.buf[0]!, b = this.buf[0]!;
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i]!.time <= t) a = this.buf[i]!;
      if (this.buf[i]!.time >= t) { b = this.buf[i]!; break; }
      b = this.buf[i]!;
    }
    const span = b.time - a.time;
    const k = span > 0 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 1;
    const out: PlayerState[] = [];
    for (const [id, pb] of b.players) {
      const pa = a.players.get(id);
      if (!pa) { out.push(pb); continue; }
      out.push({ ...pb, x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k });
    }
    return out;
  }
}

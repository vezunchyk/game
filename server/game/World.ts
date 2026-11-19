// ============================================================================
// server/game/World.ts
// Ігровий світ: карта + всі гравці онлайн. Єдине місце, що змінює стан гри.
// ============================================================================
import type { MsgSnapshot, PlayerState } from "../../shared/protocol.js";
import { config } from "../config.js";
import type { GameMap } from "../map/MapLoader.js";
import { isBlocked } from "./Collision.js";
import { stepPlayer } from "./Movement.js";
import { Player } from "./Player.js";

export class World {
  readonly players = new Map<number, Player>();
  private nextId = 1;
  tick = 0;

  constructor(public readonly map: GameMap) {}

  /** Додає гравця у світ. Якщо збережена позиція не підходить — шукає вільне місце. */
  addPlayer(nick: string, savedX: number | null, savedY: number | null): Player {
    let x: number, y: number;
    if (savedX !== null && savedY !== null && !isBlocked(this.map, savedX, savedY, 1)) {
      x = savedX; y = savedY;
    } else {
      ({ x, y } = this.findSpawn());
    }
    const player = new Player(this.nextId++, nick, x, y);
    this.players.set(player.id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  /** Спавн: з карти (якщо є вільна точка), інакше — спіраль навколо центру світу. */
  private findSpawn(): { x: number; y: number } {
    const free = this.map.spawns.filter((s) => !isBlocked(this.map, s.x, s.y, 1));
    if (free.length > 0) return free[Math.floor(Math.random() * free.length)]!;

    const b = this.map.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    for (let r = 0; r < 600; r += 8) {
      for (let a = 0; a < 16; a++) {
        const x = cx + Math.cos((a / 16) * Math.PI * 2) * r;
        const y = cy + Math.sin((a / 16) * Math.PI * 2) * r * 0.5;
        if (!isBlocked(this.map, x, y, 1)) return { x, y };
      }
    }
    return { x: cx, y: cy };
  }

  /** Один ігровий тік: рухаємо всіх гравців. Викликається з GameLoop. */
  update(now: number): void {
    this.tick++;
    for (const p of this.players.values()) {
      stepPlayer(p, this.map, now, config.inputTimeoutMs);
    }
  }

  /** Знімок стану для розсилки клієнтам. */
  snapshot(): MsgSnapshot {
    const players: PlayerState[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        nick: p.nick,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        floor: p.floor,
        dir: p.dir,
        mv: p.moving,
        st: p.stair >= 0,
      });
    }
    return { t: "snap", tick: this.tick, players };
  }
}

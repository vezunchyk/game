// ============================================================================
// server/db/PlayerStore.ts
// Збереження акаунтів і позицій. Два варіанти з однаковим інтерфейсом:
//   MemoryStore   — у пам'яті (для локальних тестів, зникає після рестарту)
//   SupabaseStore — Postgres через REST API Supabase (ключ лише на сервері)
// Решта коду про БД нічого не знає — працює тільки з інтерфейсом PlayerStore.
// ============================================================================
import { config } from "../config.js";

export interface PlayerRecord {
  nick: string;
  tokenHash: string;
  x: number | null;
  y: number | null;
}

export interface PlayerStore {
  get(nick: string): Promise<PlayerRecord | null>;
  create(rec: PlayerRecord): Promise<void>;
  savePosition(nick: string, x: number, y: number): Promise<void>;
}

// ---------------------------------------------------------------------------
export class MemoryStore implements PlayerStore {
  private data = new Map<string, PlayerRecord>();
  async get(nick: string) { return this.data.get(nick.toLowerCase()) ?? null; }
  async create(rec: PlayerRecord) { this.data.set(rec.nick.toLowerCase(), { ...rec }); }
  async savePosition(nick: string, x: number, y: number) {
    const r = this.data.get(nick.toLowerCase());
    if (r) { r.x = x; r.y = y; }
  }
}

// ---------------------------------------------------------------------------
export class SupabaseStore implements PlayerStore {
  private base: string;
  private headers: Record<string, string>;

  constructor(url: string, key: string) {
    this.base = `${url.replace(/\/$/, "")}/rest/v1/players`;
    this.headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  async get(nick: string): Promise<PlayerRecord | null> {
    const res = await fetch(`${this.base}?nick_lower=eq.${encodeURIComponent(nick.toLowerCase())}&select=*`, { headers: this.headers });
    if (!res.ok) throw new Error(`Supabase get: ${res.status}`);
    const rows = (await res.json()) as { nick: string; token_hash: string; x: number | null; y: number | null }[];
    const r = rows[0];
    return r ? { nick: r.nick, tokenHash: r.token_hash, x: r.x, y: r.y } : null;
  }

  async create(rec: PlayerRecord): Promise<void> {
    const res = await fetch(this.base, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ nick: rec.nick, nick_lower: rec.nick.toLowerCase(), token_hash: rec.tokenHash, x: rec.x, y: rec.y }),
    });
    if (!res.ok) throw new Error(`Supabase create: ${res.status}`);
  }

  async savePosition(nick: string, x: number, y: number): Promise<void> {
    const res = await fetch(`${this.base}?nick_lower=eq.${encodeURIComponent(nick.toLowerCase())}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify({ x, y }),
    });
    if (!res.ok) throw new Error(`Supabase save: ${res.status}`);
  }
}

/** Вибирає сховище за налаштуваннями. */
export function createStore(): PlayerStore {
  if (config.supabaseUrl && config.supabaseKey) {
    console.log("[db] Supabase");
    return new SupabaseStore(config.supabaseUrl, config.supabaseKey);
  }
  console.log("[db] у пам'яті (SUPABASE_URL / SUPABASE_SERVICE_KEY не задані)");
  return new MemoryStore();
}

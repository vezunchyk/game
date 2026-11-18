// ============================================================================
// server/network/Auth.ts
// Простий вхід по ніку. Перший вхід з ніком реєструє його і видає секретний
// токен; браузер зберігає токен, і ніхто інший цей нік зайняти не зможе.
// В БД лежить тільки хеш токена. Пізніше сюди додамо паролі.
// ============================================================================
import crypto from "node:crypto";
import { NICK_MAX, NICK_MIN } from "../../shared/constants.js";
import type { ErrorCode } from "../../shared/protocol.js";
import type { PlayerRecord, PlayerStore } from "../db/PlayerStore.js";

const NICK_RE = /^[\p{L}\p{N}_-]+$/u;
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export type AuthResult =
  | { ok: true; record: PlayerRecord; token: string }
  | { ok: false; code: ErrorCode };

export async function authenticate(store: PlayerStore, nick: unknown, token: unknown): Promise<AuthResult> {
  if (typeof nick !== "string" || nick.length < NICK_MIN || nick.length > NICK_MAX || !NICK_RE.test(nick)) {
    return { ok: false, code: "bad_nick" };
  }
  const existing = await store.get(nick);
  if (existing) {
    // Нік уже зайнятий: пускаємо тільки з правильним токеном.
    if (typeof token !== "string" || hash(token) !== existing.tokenHash) return { ok: false, code: "nick_taken" };
    return { ok: true, record: existing, token };
  }
  const newToken = crypto.randomBytes(24).toString("hex");
  const record: PlayerRecord = { nick, tokenHash: hash(newToken), x: null, y: null };
  await store.create(record);
  return { ok: true, record, token: newToken };
}

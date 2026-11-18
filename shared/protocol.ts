// ============================================================================
// shared/protocol.ts
// Усі повідомлення між клієнтом і сервером. Тільки типи, без логіки.
//
// ВАЖЛИВО (сервер вирішує все): клієнт надсилає лише НАМІРИ (куди тисне
// джойстик), ніколи координати. Позицію, швидкість і колізії рахує сервер.
// ============================================================================

// ---------- Клієнт -> Сервер ------------------------------------------------

/** Вхід у гру. token потрібен, якщо цей нік уже реєструвався. */
export interface MsgLogin {
  t: "login";
  v: number; // PROTOCOL_VERSION
  nick: string;
  token?: string;
}

/**
 * Намір руху: напрямок на екрані, довжина 0..1 (аналоговий джойстик).
 * Це СТАН, а не команда "зробити крок": сервер просто запам'ятовує його
 * і сам рухає гравця в кожному тіку. Тому повторні повідомлення
 * не можуть прискорити персонажа.
 */
export interface MsgInput {
  t: "input";
  dx: number;
  dy: number;
}

export type ClientMsg = MsgLogin | MsgInput;

// ---------- Сервер -> Клієнт ------------------------------------------------

export interface MsgWelcome {
  t: "welcome";
  id: number; // мій id в світі
  token: string; // секрет нікнейма: клієнт зберігає в браузері
  tickRate: number;
}

export type ErrorCode = "bad_version" | "bad_nick" | "nick_taken" | "already_online" | "bad_message" | "rate_limit" | "server_error";

export interface MsgError {
  t: "error";
  code: ErrorCode;
}

/** Стан одного гравця в знімку світу. */
export interface PlayerState {
  id: number;
  nick: string;
  x: number;
  y: number;
  floor: number; // поверх (1, 2, 3...)
  dir: number; // Dir
  mv: boolean; // true — іде (грає анімація ходьби)
}

/** Знімок світу, який сервер розсилає кожен тік. */
export interface MsgSnapshot {
  t: "snap";
  tick: number;
  players: PlayerState[];
}

export type ServerMsg = MsgWelcome | MsgError | MsgSnapshot;

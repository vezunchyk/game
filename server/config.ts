// ============================================================================
// server/config.ts
// Налаштування сервера. Значення беруться зі змінних середовища
// (на Hugging Face вони задаються в Settings -> Variables and secrets).
// ============================================================================
import path from "node:path";

export const config = {
  /** Порт. Hugging Face Docker Space очікує 7860. */
  port: Number(process.env.PORT ?? 7860),

  /** Папка зі статикою для клієнта. */
  publicDir: path.resolve("public"),

  /** Карта для сервера (колізії, межі, спавни). Створюється `npm run build-map`. */
  serverMapPath: path.resolve("data/server-map.json"),

  /** Supabase. Якщо не задано — гравці живуть у пам'яті (зникають після рестарту). */
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseKey: process.env.SUPABASE_SERVICE_KEY ?? "",

  /** Як часто зберігати позиції онлайн-гравців у БД (мс). */
  autosaveMs: 30_000,

  /** Макс. повідомлень від одного клієнта за секунду (захист від спаму/читів). */
  maxMsgPerSecond: 60,

  /** Через скільки мс без нового input вважаємо, що гравець відпустив джойстик. */
  inputTimeoutMs: 600,

  /** Скільки секунд дається на логін після підключення. */
  loginTimeoutMs: 10_000,
};

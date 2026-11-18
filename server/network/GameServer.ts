// ============================================================================
// server/network/GameServer.ts
// HTTP (віддає клієнта) + WebSocket (гра). Тут тільки "мережа": розібрати
// повідомлення, перевірити, передати у світ. Правил гри тут немає.
// ============================================================================
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, TICK_RATE } from "../../shared/constants.js";
import type { ClientMsg, ErrorCode, ServerMsg } from "../../shared/protocol.js";
import { config } from "../config.js";
import type { PlayerStore } from "../db/PlayerStore.js";
import { sanitizeInput } from "../game/Movement.js";
import type { Player } from "../game/Player.js";
import type { World } from "../game/World.js";
import { authenticate } from "./Auth.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".css": "text/css", ".ico": "image/x-icon",
};

/** Стан одного підключення. */
interface Client {
  ws: WebSocket;
  player: Player | null;
  nick: string | null;
  loggingIn: boolean;
  msgCount: number; // повідомлень за поточну секунду
}

export class GameServer {
  private http: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<Client>();

  constructor(private readonly world: World, private readonly store: PlayerStore) {
    this.http = http.createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 1024 });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    // Раз на секунду скидаємо лічильники спаму.
    setInterval(() => this.clients.forEach((c) => (c.msgCount = 0)), 1000);
    // Автозбереження позицій.
    setInterval(() => void this.saveAll(), config.autosaveMs);
  }

  listen(): void {
    this.http.listen(config.port, () => console.log(`[server] http://localhost:${config.port}`));
  }

  close(): void {
    this.wss.close();
    this.http.close();
  }

  // ---------- Статика (клієнт) ---------------------------------------------
  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (urlPath === "/favicon.ico") { res.writeHead(204).end(); return; }
    const rel = urlPath === "/" ? "index.html" : urlPath;
    const file = path.join(config.publicDir, path.normalize(rel));
    // Захист: не виходимо за межі папки public.
    if (!file.startsWith(config.publicDir)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache", // браузер завжди перевіряє, чи файл не змінився (інакше тримає стару карту)
      });
      res.end(data);
    });
  }

  // ---------- Підключення ---------------------------------------------------
  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, player: null, nick: null, loggingIn: false, msgCount: 0 };
    this.clients.add(client);

    // Якщо не залогінився вчасно — відключаємо.
    const loginTimer = setTimeout(() => { if (!client.player) ws.close(); }, config.loginTimeoutMs);

    ws.on("message", (data) => {
      if (++client.msgCount > config.maxMsgPerSecond) { this.fail(client, "rate_limit"); return; }
      let msg: ClientMsg;
      try { msg = JSON.parse(data.toString()); } catch { this.fail(client, "bad_message"); return; }
      void this.onMessage(client, msg);
    });

    ws.on("close", () => {
      clearTimeout(loginTimer);
      this.clients.delete(client);
      if (client.player) {
        void this.store.savePosition(client.player.nick, client.player.x, client.player.y).catch(console.error);
        this.world.removePlayer(client.player.id);
      }
    });
    ws.on("error", () => ws.close());
  }

  private async onMessage(client: Client, msg: ClientMsg): Promise<void> {
    if (!msg || typeof msg !== "object") return this.fail(client, "bad_message");

    if (msg.t === "login") return this.onLogin(client, msg);

    if (msg.t === "input") {
      if (!client.player) return; // до логіну input ігноруємо
      // Тільки ЗАПИСУЄМО намір. Рухає гравця виключно ігровий цикл.
      const v = sanitizeInput(msg.dx, msg.dy);
      client.player.inputX = v.x;
      client.player.inputY = v.y;
      client.player.inputAt = Date.now();
      return;
    }
    this.fail(client, "bad_message");
  }

  private async onLogin(client: Client, msg: Extract<ClientMsg, { t: "login" }>): Promise<void> {
    if (client.player || client.loggingIn) return;
    if (msg.v !== PROTOCOL_VERSION) return this.fail(client, "bad_version");
    client.loggingIn = true;
    try {
      const auth = await authenticate(this.store, msg.nick, msg.token);
      if (!auth.ok) { client.loggingIn = false; return this.sendError(client, auth.code); }

      // Один нік — одна сесія.
      for (const c of this.clients) {
        if (c.player && c.player.nick.toLowerCase() === auth.record.nick.toLowerCase()) {
          client.loggingIn = false;
          return this.sendError(client, "already_online");
        }
      }
      if (client.ws.readyState !== WebSocket.OPEN) return; // встиг відключитись
      client.player = this.world.addPlayer(auth.record.nick, auth.record.x, auth.record.y);
      this.send(client, { t: "welcome", id: client.player.id, token: auth.token, tickRate: TICK_RATE });
      console.log(`[join] ${client.player.nick} (id ${client.player.id})`);
    } catch (e) {
      console.error("[login]", e);
      client.loggingIn = false;
      this.sendError(client, "server_error");
    }
  }

  // ---------- Розсилка ------------------------------------------------------
  /** Викликається після кожного тіка: шле всім залогіненим знімок світу. */
  broadcastSnapshot(): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(this.world.snapshot());
    for (const c of this.clients) {
      if (c.player && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }

  private async saveAll(): Promise<void> {
    for (const c of this.clients) {
      if (c.player) await this.store.savePosition(c.player.nick, c.player.x, c.player.y).catch(console.error);
    }
  }

  private send(client: Client, msg: ServerMsg): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }
  private sendError(client: Client, code: ErrorCode): void { this.send(client, { t: "error", code }); }
  private fail(client: Client, code: ErrorCode): void { this.sendError(client, code); client.ws.close(); }
}

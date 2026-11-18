// ============================================================================
// client/net/Connection.ts
// WebSocket-з'єднання із сервером. Знає тільки про повідомлення, не про малювання.
// ============================================================================
import { PROTOCOL_VERSION } from "../../shared/constants.js";
import type { ClientMsg, ServerMsg } from "../../shared/protocol.js";

export class Connection {
  private ws: WebSocket | null = null;
  onMessage: (msg: ServerMsg) => void = () => {};
  onClose: () => void = () => {};

  /** Підключається і одразу надсилає логін. */
  connect(nick: string, token: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}`);
      this.ws = ws;
      ws.onopen = () => {
        this.send({ t: "login", v: PROTOCOL_VERSION, nick, token });
        resolve();
      };
      ws.onerror = () => reject(new Error("Не вдалося підключитися"));
      ws.onmessage = (e) => this.onMessage(JSON.parse(e.data as string) as ServerMsg);
      ws.onclose = () => this.onClose();
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

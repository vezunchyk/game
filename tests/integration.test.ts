// Інтеграційний тест: справжній сервер + справжні WebSocket-клієнти.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { PLAYER_SPEED, PROTOCOL_VERSION } from "../shared/constants.js";

const PORT = 7861;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(nick: string, token?: string) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [] as any[], last: () => c.msgs.filter((m) => m.t === "snap").at(-1), me: -1 };
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); c.msgs.push(m); if (m.t === "welcome") c.me = m.id; });
  ws.on("open", () => ws.send(JSON.stringify({ t: "login", v: PROTOCOL_VERSION, nick, token })));
  return c;
}
const mePos = (c: ReturnType<typeof client>) => c.last()?.players.find((p: any) => p.id === c.me);

export async function run(): Promise<void> {
  const srv = spawn("node", ["dist/server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
  try {
    await sleep(800);

    // 1. Логін і отримання токена
    const a = client("Alpha");
    await sleep(400);
    const welcome = a.msgs.find((m) => m.t === "welcome");
    assert.ok(welcome, "не отримали welcome");
    assert.ok(welcome.token.length >= 32);

    // 2. Той самий нік без токена -> відмова; нік онлайн -> відмова навіть з токеном
    const thief = client("Alpha");
    await sleep(300);
    assert.equal(thief.msgs.find((m) => m.t === "error")?.code, "nick_taken");
    const dup = client("Alpha", welcome.token);
    await sleep(300);
    assert.equal(dup.msgs.find((m) => m.t === "error")?.code, "already_online");

    // 3. Погана версія і поганий нік
    const bad = new WebSocket(`ws://localhost:${PORT}`); const badMsgs: any[] = [];
    bad.on("message", (d) => badMsgs.push(JSON.parse(d.toString())));
    bad.on("open", () => bad.send(JSON.stringify({ t: "login", v: 999, nick: "Zed" })));
    await sleep(300);
    assert.equal(badMsgs[0]?.code, "bad_version");
    const bn = client("a b!");
    await sleep(300);
    assert.equal(bn.msgs.find((m) => m.t === "error")?.code, "bad_nick");

    // 4. Рух: тиснемо вправо 2с, спамимо input 40 раз/с (читерська частота) — швидкість не росте
    const start = mePos(a);
    assert.ok(start, "немає знімка");
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      a.ws.send(JSON.stringify({ t: "input", dx: 1, dy: 0 }));
      a.ws.send(JSON.stringify({ t: "input", dx: 1, dy: 0 }));
      await sleep(50);
    }
    const end = mePos(a);
    const dist = end.x - start.x;
    const secs = (Date.now() - t0) / 1000;
    const speed = dist / secs;
    console.log(`  швидкість по сервері: ${speed.toFixed(1)} (норма ${PLAYER_SPEED}), напрямок=${end.dir}, mv=${end.mv}`);
    assert.ok(speed > PLAYER_SPEED * 0.8 && speed < PLAYER_SPEED * 1.1, `швидкість ${speed}`);
    assert.equal(end.dir, 2);

    // 5. Читерські координати в input ігноруються (клієнт не може телепортуватись)
    const before = mePos(a);
    a.ws.send(JSON.stringify({ t: "input", dx: 0, dy: 0, x: 99999, y: 99999 }));
    await sleep(400);
    const after = mePos(a);
    assert.ok(Math.abs(after.x - before.x) < 20 && Math.abs(after.y - before.y) < 20, "телепорт спрацював!");

    // 6. Відпустили — зупинились
    await sleep(800);
    const s1 = mePos(a); await sleep(300); const s2 = mePos(a);
    assert.equal(s1.x, s2.x);
    assert.equal(s2.mv, false);

    // 7. Другий гравець бачить першого
    const b = client("Bravo");
    await sleep(500);
    assert.equal(b.last().players.length, 2);
    console.log("integration: OK");
  } finally {
    srv.kill();
  }
}

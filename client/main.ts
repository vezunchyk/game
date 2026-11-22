// ============================================================================
// client/main.ts
// Точка входу клієнта: екран входу -> підключення -> ігровий цикл малювання.
// Клієнт НІЧОГО не вирішує: шле наміри, малює те, що прислав сервер.
// ============================================================================
import type { ErrorCode, ServerMsg } from "../shared/protocol.js";
import { InputController } from "./input/InputController.js";
import { Joystick } from "./input/Joystick.js";
import { Keyboard } from "./input/Keyboard.js";
import { Connection } from "./net/Connection.js";
import { CharacterRenderer } from "./render/CharacterRenderer.js";
import { Interpolation } from "./render/Interpolation.js";
import { MapRenderer, type View } from "./render/MapRenderer.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ERROR_TEXT: Record<ErrorCode, string> = {
  bad_version: "Стара версія гри. Оновіть сторінку.",
  bad_nick: "Нік: 3–16 символів, літери, цифри, _ або -.",
  nick_taken: "Цей нік уже зайнятий іншим гравцем.",
  already_online: "Цей нік зараз у грі.",
  bad_message: "Помилка повідомлення.",
  rate_limit: "Забагато запитів.",
  server_error: "Помилка сервера. Спробуйте ще раз.",
};

const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
const debug = new URLSearchParams(location.search).has("debug");

declare const __BUILD_ID__: string;
// Мала мітка збірки в куті екрана (видно і в грі, і на скріншоті) — щоб одразу бачити, яка версія клієнта працює.
{
  const tag = document.createElement("div");
  tag.textContent = __BUILD_ID__ + " · map v6 · group/y";
  tag.style.cssText = "position:fixed;left:6px;bottom:4px;z-index:50;font:10px monospace;color:#fff;opacity:.55;pointer-events:none";
  document.body.appendChild(tag);
  $("login-status").textContent = "збірка: " + __BUILD_ID__;
}
const conn = new Connection();
const interp = new Interpolation();
const map = new MapRenderer();
map.debug = debug;
const chars = new CharacterRenderer();
const joystick = new Joystick($("joy-zone"));
const keyboard = new Keyboard();
const input = new InputController(conn, joystick, keyboard);

let myId = -1;
let nickForToken = "";
let debugCollisions: number[][][] = [];

// ---------- Вхід -------------------------------------------------------------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nick = $<HTMLInputElement>("nick").value.trim();
  const status = $("login-status");
  status.textContent = "Підключення...";
  nickForToken = nick;
  try {
    await Promise.all([map.load(), chars.load()]);
    if (debug) debugCollisions = await (await fetch("/assets/debug-collisions.json")).json();
    await conn.connect(nick, localStorage.getItem(`token:${nick.toLowerCase()}`) ?? undefined);
  } catch {
    status.textContent = "Не вдалося підключитися до сервера.";
  }
});

conn.onMessage = (msg: ServerMsg) => {
  if (msg.t === "welcome") {
    myId = msg.id;
    localStorage.setItem(`token:${nickForToken.toLowerCase()}`, msg.token);
    $("login").style.display = "none";
    $("joy-zone").style.display = "block";
    requestAnimationFrame(frame);
  } else if (msg.t === "error") {
    $("login-status").textContent = ERROR_TEXT[msg.code] ?? msg.code;
  } else if (msg.t === "snap") {
    interp.push(msg);
  }
};
conn.onClose = () => {
  $("login").style.display = "flex";
  $("joy-zone").style.display = "none";
  if (!$("login-status").textContent?.includes("зайнятий")) $("login-status").textContent = "З'єднання втрачено. Увійдіть знову.";
};

// ---------- Малювання ----------------------------------------------------------
/** Масштаб картинки. Завжди ЦІЛЕ число, щоб піксель-арт був чітким. Міняти тут. */
const ZOOM_MIN = 2;
const ZOOM_MAX = 4;
const WORLD_PX_ACROSS = 200; // скільки світових пікселів має вміщатись по ширині екрана
function pickZoom(cssW: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(cssW / WORLD_PX_ACROSS)));
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
}
window.addEventListener("resize", resize);
resize();

function frame(): void {
  input.update();
  const now = performance.now();
  // Позиції — у цілі світові пікселі (КОПІЇ, щоб не псувати буфер інтерполяції): і камера, і гравець
  // спираються на одну цілу точку, тож персонаж не \"дрижить\" відносно центру екрана.
  const players = interp.sample().map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) }));
  const me = players.find((p) => p.id === myId);

  const dpr = window.devicePixelRatio || 1;
  // Цілий масштаб (у фізичних пікселях): при дробовому (напр. 2.75 * 3) піксельна сітка \"пливе\".
  const scale = Math.max(1, Math.round(pickZoom(window.innerWidth) * dpr));
  const viewW = canvas.width / scale;
  const viewH = canvas.height / scale;
  const camX = (me?.x ?? 0) - Math.floor(viewW / 2);
  const camY = (me?.y ?? 0) - 32 - Math.floor(viewH / 2);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0b0d0a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -camX * scale, -camY * scale);
  ctx.imageSmoothingEnabled = false;

  const view: View = { left: camX - 8, top: camY - 8, right: camX + viewW + 8, bottom: camY + viewH + 8 };

  // Карта і персонажі: групи (поверхи) по черзі; всередині поверху тайли й персонажі за y точки опори.
  // На сходах глядач "стоїть" на верхньому поверсі сходів (me.st).
  const myFloor = me?.floor ?? 1;
  const myLevel = me?.st || myFloor;
  map.draw(ctx, view, now, { x: me?.x ?? 0, y: me?.y ?? 0, floor: myFloor, level: myLevel }, players.map((p) => ({
    x: p.x, y: p.y, level: p.st || p.floor || 1,
    draw: () => chars.draw(ctx, p, now, p.id === myId),
  })));

  if (debug) { map.drawDebug(ctx, view); drawDebug(view, me ?? null); }
  requestAnimationFrame(frame);
}

/** ?debug у адресі: червоні контури колізій поверх карти (перевірити, що все збігається). */
function drawDebug(_v: View, me: { x: number; y: number; floor?: number; st?: number } | null): void {
  ctx.font = "5px monospace";
  if (me) {
    // Позиція ніг і поверх. Жовті крапки на карті — точки опори тайлів (за ними сортується).
    ctx.fillStyle = "#0f0";
    ctx.fillText(`me ${Math.round(me.x)},${Math.round(me.y)} f${me.floor ?? 1}${me.st ? " stairs→" + me.st : ""}`, me.x - 40, me.y + 14);
  }
  ctx.strokeStyle = "rgba(255,0,0,0.9)";
  ctx.lineWidth = 1;
  for (const poly of debugCollisions) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x!, y!) : ctx.lineTo(x!, y!)));
    ctx.closePath();
    ctx.stroke();
  }
}

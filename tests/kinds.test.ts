// Тести "видів тайлів": розпізнавання напрямку за картинкою, вибір виду за папкою, збірка не зупиняється на невідомій папці (вид за замовчуванням + попередження), зупиняється на помилці напрямку.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { isBlocked } from "../server/game/Collision.js";
import { loadMap } from "../server/map/MapLoader.js";
// @ts-ignore  (.mjs без типів)
import { axisFromPicture, decodePng } from "../scripts/lib/png.mjs";
// @ts-ignore
import { classifyTile } from "../scripts/lib/folder-kinds.mjs";

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** PNG w×h; alphaAt(x, y) -> true, якщо піксель непрозорий. */
function makePng(w: number, h: number, alphaAt: (x: number, y: number) => boolean): Buffer {
  const rows = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const on = alphaAt(x, y);
      rows[o] = 120; rows[o + 1] = 90; rows[o + 2] = 60; rows[o + 3] = on ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/** Паралелограм-стіна: край іде з нахилом k (px по y на 1 px по x), висота граней 40. */
const wall = (k: number) => (x: number, y: number) => { const top = 10 + k * x; return y >= top && y < top + 40; };
const axis = (buf: Buffer, frameW?: number) => axisFromPicture(decodePng(buf), frameW);

export function run(): void {
  // 1. Напрям за формою картинки
  assert.equal(axis(makePng(40, 80, wall(0.5))), 2, "край іде вниз-праворуч => вісь R");
  assert.equal(axis(makePng(40, 80, wall(-0.5))), 1, "край іде вгору-праворуч => вісь L");
  assert.equal(axis(makePng(6, 80, wall(0.5))), 2, "вузька смужка (рамка дверей) теж розпізнається");
  const corner = (x: number, y: number) => { const top = 10 + 0.5 * Math.abs(x - 20); return y >= top && y < top + 40; };
  assert.equal(axis(makePng(40, 80, corner)), 0, "кут (V-подібний край) — напрям невідомий");
  assert.equal(axis(makePng(40, 80, () => true)), 0, "прямокутник — напрям невідомий");
  // тільки перший кадр: 2 кадри по 40 px, у другому інший нахил
  const twoFrames = (x: number, y: number) => (x < 40 ? wall(0.5)(x, y) : wall(-0.5)(x - 40, y));
  assert.equal(axis(makePng(80, 80, twoFrames), 40), 2, "аналізується лише перший кадр");

  // 2. Вид за папкою: найглибша папка виграє; "внутрішні" і світло/темно — позначки
  const cfg = JSON.parse(fs.readFileSync("map-src/folder-kinds.json", "utf8"));
  const folders = new Map([
    ["f1", { id: "f1", name: "Текстури", parentId: null }],
    ["f2", { id: "f2", name: "Стіни", parentId: "f1" }],
    ["f3", { id: "f3", name: "Вершки", parentId: "f2" }],
    ["f4", { id: "f4", name: "Внутрішні", parentId: "f3" }],
    ["f5", { id: "f5", name: "Темні", parentId: "f4" }],
    ["f6", { id: "f6", name: "Світлі", parentId: "f2" }],
    ["f7", { id: "f7", name: "Щось нове", parentId: "f1" }],
  ]);
  const beam = classifyTile({ folderId: "f5" }, folders, cfg);
  assert.equal(beam.kind, "beam", "Стіни/Вершки: найглибша папка (Вершки) перебиває Стіни");
  assert.equal(beam.interior, true);
  assert.equal(beam.shade, "dark");
  const wallTile = classifyTile({ folderId: "f6" }, folders, cfg);
  assert.equal(wallTile.kind, "wall");
  assert.equal(wallTile.shade, "light");
  assert.equal(wallTile.interior, false);
  assert.equal(classifyTile({ folderId: "f7" }, folders, cfg).kind, "", "невідома папка => вид порожній");

  // 3. Невідома папка: у суворому режимі збірка зупиняється й НЕ чіпає файли гри; у звичайному — збирається з видом prop + попередження
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "buildmap-"));
  const png = makePng(40, 80, wall(0.5));
  const map = {
    name: "тест", cellSize: 64, gridType: "iso",
    tileFolders: [{ id: "x", name: "Невідома папка", parentId: null }],
    tiles: { t1: { name: "a", dataURL: "data:image/png;base64," + png.toString("base64"), folderId: "x", pivotX: 0.5, pivotY: 1 } },
    placements: [{ id: "p1", tileId: "t1", x: 0, y: 0, z: 1 }],
    collisions: [], layers: [],
  };
  const mapFile = path.join(tmp, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify(map));
  let failed = false, out = "";
  try {
    execFileSync(process.execPath, [path.resolve("scripts/build-map.mjs"), mapFile], { cwd: tmp, stdio: "pipe", env: { ...process.env, STRICT_KINDS: "1" } });
  } catch (e: any) { failed = true; out = String(e.stderr); }
  assert.ok(failed, "у суворому режимі збірка має впасти на невідомій папці");
  assert.match(out, /folder-kinds\.json/, "помилка називає файл, де додати папку");
  assert.ok(!fs.existsSync(path.join(tmp, "public/assets/map.json")), "при помилці файли гри не пишуться");

  const soft = execFileSync(process.execPath, [path.resolve("scripts/build-map.mjs"), mapFile], { cwd: tmp, stdio: "pipe", env: { ...process.env, STRICT_KINDS: "" } }).toString();
  assert.match(soft, /ПОПЕРЕДЖЕННЯ/, "невідома папка — попередження, а не зупинка");
  const softBuilt = JSON.parse(fs.readFileSync(path.join(tmp, "public/assets/map.json"), "utf8"));
  assert.equal(softBuilt.tiles.t1.kind, "prop", "тайл без відомої папки отримує вид за замовчуванням");

  // ...а з відомою папкою збирається (+ дві плитки землі далеко одна від одної, щоб межі світу були просторі)
  map.tileFolders[0]!.name = "Стіни";
  map.tileFolders.push({ id: "g", name: "Ромби", parentId: null });
  (map.tiles as any).t2 = { name: "земля", dataURL: "data:image/png;base64," + makePng(64, 33, () => true).toString("base64"), folderId: "g", pivotX: 0.5, pivotY: 0.5 };
  map.placements.push({ id: "g1", tileId: "t2", x: -600, y: -600, z: 1 }, { id: "g2", tileId: "t2", x: 600, y: 600, z: 1 });
  fs.writeFileSync(mapFile, JSON.stringify(map));
  execFileSync(process.execPath, [path.resolve("scripts/build-map.mjs"), mapFile], { cwd: tmp, stdio: "pipe" });
  const built = JSON.parse(fs.readFileSync(path.join(tmp, "public/assets/map.json"), "utf8"));
  assert.equal(built.tiles.t1.kind, "wall");
  assert.equal(built.tiles.t1.axis, 2);

  // 4. Автоколізія стіни: смуга ЗА лінією основи, перед нею вільно, за кінцем тайла вільно
  const [gx, gy] = [built.placements[0][6], built.placements[0][7]];
  const s0 = gy - gx / 2, t0 = gy + gx / 2;
  const sm = loadMap(path.join(tmp, "data/server-map.json"));
  const blocked = (ds: number, dt: number) => isBlocked(sm, t0 + dt - (s0 + ds), (s0 + ds + t0 + dt) / 2, 1);
  assert.ok(blocked(-3, 0), "у товщі стіни — зайнято");
  assert.ok(blocked(3, 0), "впритул перед лінією основи ноги вже торкаються смуги");
  assert.ok(!blocked(12, 0), "перед стіною вільно");
  assert.ok(!blocked(-20, 0), "за стіною (поза товщиною) вільно");
  assert.ok(blocked(-3, 15) && !blocked(-3, 40), "смуга лише вздовж тайла, за його кінцем вільно");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("kinds: OK");
}

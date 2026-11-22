// ============================================================================
// scripts/build.mjs — збирає сервер (dist/server.js) і клієнт (public/game.js)
// ============================================================================
import { build } from "esbuild";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// Карта: якщо є map-src/map.json (експорт TileWeaver) — перезбираємо з нього карту гри автоматично.
// Тож для нової карти достатньо замінити ОДИН файл map-src/map.json.
if (fs.existsSync("map-src/map.json")) {
  execFileSync("node", ["scripts/build-map.mjs", "map-src/map.json"], { stdio: "inherit" });
}

await build({
  entryPoints: ["server/index.ts"], outfile: "dist/server.js",
  bundle: true, platform: "node", format: "esm", target: "node22",
  packages: "external", // ws лишається в node_modules
});
await build({
  entryPoints: ["client/main.ts"], outfile: "public/game.js",
  bundle: true, platform: "browser", format: "iife", target: "es2020", minify: false,
  define: { __BUILD_ID__: JSON.stringify("render-v7 " + new Date().toISOString().slice(0, 16).replace("T", " ")) },
});
console.log("Збірка готова.");

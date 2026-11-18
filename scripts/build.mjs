// ============================================================================
// scripts/build.mjs — збирає сервер (dist/server.js) і клієнт (public/game.js)
// ============================================================================
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"], outfile: "dist/server.js",
  bundle: true, platform: "node", format: "esm", target: "node22",
  packages: "external", // ws лишається в node_modules
});
await build({
  entryPoints: ["client/main.ts"], outfile: "public/game.js",
  bundle: true, platform: "browser", format: "iife", target: "es2020", minify: false,
  define: { __BUILD_ID__: JSON.stringify("render-v5 " + new Date().toISOString().slice(0, 16).replace("T", " ")) },
});
console.log("Збірка готова.");

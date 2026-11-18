// Збирає і запускає тести: npm test (спочатку npm run build)
import { build } from "esbuild";
await build({
  entryPoints: ["tests/all.ts"], outfile: "dist/tests.mjs", bundle: true, platform: "node",
  format: "esm", target: "node22", packages: "external",
});
await import("../dist/tests.mjs");

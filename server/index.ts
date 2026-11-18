// ============================================================================
// server/index.ts
// Точка входу сервера. Тут лише складання частин докупи.
// ============================================================================
import { config } from "./config.js";
import { createStore } from "./db/PlayerStore.js";
import { GameLoop } from "./game/GameLoop.js";
import { World } from "./game/World.js";
import { loadMap } from "./map/MapLoader.js";
import { GameServer } from "./network/GameServer.js";

const map = loadMap(config.serverMapPath);
console.log(`[map] ${map.name}: ${map.collisions.length} колізій, спавнів: ${map.spawns.length}`);

const world = new World(map);
const store = createStore();
const server = new GameServer(world, store);

// Кожен тік: оновили світ -> розіслали знімок.
const loop = new GameLoop((now) => {
  world.update(now);
  server.broadcastSnapshot();
});

loop.start();
server.listen();

process.on("SIGTERM", () => { loop.stop(); server.close(); process.exit(0); });

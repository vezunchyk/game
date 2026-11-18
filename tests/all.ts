import { run as movement } from "./movement.test.js";
import { run as integration } from "./integration.test.js";
movement();
await integration();
console.log("ВСІ ТЕСТИ ПРОЙДЕНО");
process.exit(0);

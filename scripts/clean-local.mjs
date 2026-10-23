/** User-invoked cleanup only. Never runs on startup, readiness or test. */
import { readdirSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
const directory = resolve(".local");
if (existsSync(directory))
  for (const name of readdirSync(directory)) {
    if (
      /^(state_5|logs_2|goals_1|memories_1|queue_1)\.sqlite[^/]*$/.test(name) ||
      name.startsWith("luna-")
    ) {
      rmSync(join(directory, name), { recursive: true, force: true });
      console.log("Removed selected local provider artifact:", name);
    }
  }
console.log("App databases were preserved.");

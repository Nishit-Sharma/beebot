/** Official vendor's skipped install step is chmod only; never downloads or authenticates. */
import { chmodSync } from "node:fs";
import { beeBinary } from "../src/runtime-paths.mjs";
if (process.platform !== "win32") chmodSync(beeBinary(), 0o755);

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const path = join(homedir(), ".codex", "AGENTS.md");
const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
console.log("Global guidance SHA256:", sha256);
if (!process.argv.includes("--acknowledge")) {
  console.log(
    "Review ~/.codex/AGENTS.md yourself. If you approve it for Bee, run npm run review-guidance -- --acknowledge. A hash alone is not permission.",
  );
} else {
  const directory = resolve(process.env.BEE_COMPANION_DATA ?? ".local");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "reviewed-guidance.json"),
    JSON.stringify(
      {
        sha256,
        acknowledgedBy: "user-invoked-command",
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("Explicit guidance acknowledgment saved locally.");
}

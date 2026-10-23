/** Creates a local source archive only; no install, login, server or publication. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { listReleaseFiles, releaseRoot } from "./release-list.mjs";
const outputFlag = process.argv.indexOf("--out");
const output = resolve(outputFlag < 0 ? join(releaseRoot, "dist", "beebot-source.tar.gz") : process.argv[outputFlag + 1] ?? "");
if (outputFlag >= 0 && !process.argv[outputFlag + 1]) throw Error("Usage: npm run package-source -- --out /path/beebot-source.tar.gz");
if (existsSync(output) || existsSync(output + ".manifest.json")) throw Error("ReleaseOutputExists: choose a new output filename");
const files = listReleaseFiles();
const hashes = Object.fromEntries(files.map((path) => [path, createHash("sha256").update(readFileSync(join(releaseRoot, path))).digest("hex")]));
const sourceHash = createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
const stage = mkdtempSync(join(tmpdir(), "beebot-release-"));
const manifest = { product: "beebot", format: "source-only-v1", hashMethod: "SHA-256 of UTF-8 JSON sorted path-to-SHA256 mapping", sourceHash, files: hashes, excluded: [".local", ".snapshots", "evidence", "node_modules", "upstream", "design", "CHECKPOINT.md", "docs/history.md", "docs/FIXES.md"], integration: "Local Mac application; Bee-native/Watch reply delivery is not implemented or verified." };
try {
  for (const path of files) {
    const bytes = readFileSync(join(releaseRoot, path));
    if (createHash("sha256").update(bytes).digest("hex") !== hashes[path]) throw Error("ReleaseSourceChanged: retry after edits finish");
    const target = join(stage, "beebot", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(stage, "beebot", "SOURCE-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("tar", ["-czf", output, "-C", stage, "beebot"], { stdio: "pipe", timeout: 30000, maxBuffer: 65536, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  writeFileSync(output + ".manifest.json", JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ archive: output, manifest: output + ".manifest.json", sourceHash, files: files.length, published: false }, null, 2));
} finally {
  rmSync(stage, { recursive: true, force: true });
}

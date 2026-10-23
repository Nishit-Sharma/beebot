/** Source-only allowlist. Never reads local state, evidence or credentials. */
import { readdirSync, lstatSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
export const releaseRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const required = [
  "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md",
  "package.json", "package-lock.json", ".gitignore",
  "guidance/bee-pack.json", "fixtures/bee-stream.ndjson",
  "fixtures/luna-compression-agenda.md",
  // Public npm commands only; internal evaluation scripts stay local.
  "scripts/demo.mjs", "scripts/readiness.mjs", "scripts/review-guidance.mjs",
  "scripts/clean-local.mjs", "scripts/prepare-local.mjs",
  "scripts/release-list.mjs", "scripts/package-source.mjs",
];
const trees = {
  src: new Set(["mjs"]), tests: new Set(["mjs"]),
  public: new Set(["html", "css", "mjs", "js", "svg", "png", "jpg", "jpeg", "webp", "gif", "ico", "woff", "woff2", "ttf"]),
};
export function listReleaseFiles(root = releaseRoot) {
  const files = [];
  const add = (path) => {
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink() || !stat.isFile()) throw Error("ReleaseRegularFileRequired: " + path);
    files.push(path);
  };
  for (const path of required) {
    if (!existsSync(join(root, path))) throw Error("ReleaseFileMissing: " + path);
    add(path);
  }
  for (const [tree, extensions] of Object.entries(trees)) {
    const walk = (path) => {
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) throw Error("ReleaseSymlinkDenied: " + path);
      if (stat.isDirectory()) {
        for (const name of readdirSync(join(root, path)).sort()) {
          if (name.startsWith(".") || ["node_modules", "evidence", "coverage", "screenshots", "test-results", "__pycache__", "dist"].includes(name)) continue;
          walk(join(path, name));
        }
      } else if (stat.isFile() && extensions.has(path.split(".").at(-1).toLowerCase())) add(path);
    };
    if (!existsSync(join(root, tree))) throw Error("ReleaseTreeMissing: " + tree);
    walk(tree);
  }
  return [...new Set(files)].sort();
}
if (process.argv[1] && relative(releaseRoot, fileURLToPath(import.meta.url)) === relative(releaseRoot, process.argv[1]))
  console.log(listReleaseFiles().join("\n"));

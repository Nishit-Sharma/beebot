import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
export function beeBinary(platform = process.platform, arch = process.arch) {
  const os = { darwin: "mac", linux: "linux", win32: "windows" }[platform];
  if (!os || !["arm64", "x64"].includes(arch))
    throw Error("UnsupportedBeePlatform");
  return fileURLToPath(
    new URL(
      `../node_modules/@beeai/cli/dist/platforms/${os}-${arch}/bee${platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
}
/** Select from known installed CLIs by version; never authenticate or query a model. */
export function codexBinary({
  home = homedir(),
  env = process.env,
  run = spawnSync,
  platform = process.platform,
} = {}) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const probe = (binary, args) => {
    try {
      return run(binary, args, {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4096,
        env,
      });
    } catch {
      return null;
    }
  };
  const found = probe(platform === "win32" ? "where" : "which", ["codex"])
    ?.stdout?.trim()
    .split(/\r?\n/)[0];
  const local = join(
    home,
    ".local",
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
  const candidates = [...new Set([found, local].filter(Boolean))]
    .map((binary) => {
      const result = probe(binary, ["--version"]);
      const match =
        result?.status === 0 &&
        result.stdout?.match(/codex-cli (\d+)\.(\d+)\.(\d+)/);
      return { binary, version: match ? match.slice(1).map(Number) : null };
    })
    .filter((candidate) => candidate.version);
  candidates.sort(
    (a, b) =>
      b.version[0] - a.version[0] ||
      b.version[1] - a.version[1] ||
      b.version[2] - a.version[2],
  );
  return candidates[0]?.binary ?? found ?? local;
}

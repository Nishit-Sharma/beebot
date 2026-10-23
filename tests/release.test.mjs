import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
test("source-only release preserves product assets and synthetic fixtures while excluding local/private/generated material", () => {
  const files = execFileSync(process.execPath, ["scripts/release-list.mjs"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.ok(files.includes("fixtures/bee-stream.ndjson"));
  assert.ok(!files.includes("docs/history.md"));
  assert.ok(!files.includes("docs/FIXES.md"));
  assert.ok(!files.some((path) => path.startsWith("docs/")));
  assert.ok(!files.includes("SUBMISSION.md"));
  assert.ok(!files.includes("scripts/live-synthetic-check.mjs"));
  assert.ok(!files.includes("scripts/evaluate-private-preparation.mjs"));
  assert.ok(files.includes("guidance/bee-pack.json"));
  assert.ok(files.includes("tests/fixtures/crash-worker.mjs"));
  assert.match(readFileSync("THIRD_PARTY_NOTICES.md", "utf8"), /Copyright \(c\) 2026 bee-cli contributors/);
  assert.ok(files.includes("scripts/package-source.mjs"));
  assert.ok(
    files.every(
      (p) =>
        !p.startsWith(".local/") &&
        !p.startsWith(".snapshots/") &&
        !p.startsWith("evidence/") &&
        !p.startsWith("design/references/"),
    ),
  );
  const directory = mkdtempSync(join(tmpdir(), "bee-release-"));
  try {
    for (const p of files) {
      const out = join(directory, p);
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(p, out);
    }
    assert.ok(existsSync(join(directory, "LICENSE")));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(
      process.execPath,
      ["--test", "--test-reporter=spec", "tests/bee-ingestion.test.mjs"],
      { cwd: directory, encoding: "utf8", env },
    );
    assert.match(output, /fail 0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("source package is inspectable and hashes every included file without shipping local state", () => {
  const directory = mkdtempSync(join(tmpdir(), "beebot-package-"));
  try {
    const archive = join(directory, "beebot-source.tar.gz");
    const receipt = JSON.parse(execFileSync(process.execPath, ["scripts/package-source.mjs", "--out", archive], { encoding: "utf8" }));
    assert.equal(receipt.published, false);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    assert.ok(entries.every((path) => path.startsWith("beebot/") && !/(^|\/)\._/.test(path)));
    assert.equal(entries.filter((path) => !path.endsWith("/")).length, receipt.files + 1);
    execFileSync("tar", ["-xzf", archive, "-C", directory]);
    const manifest = JSON.parse(readFileSync(join(directory, "beebot", "SOURCE-MANIFEST.json"), "utf8"));
    assert.equal(manifest.sourceHash, receipt.sourceHash);
    assert.equal(Object.keys(manifest.files).length, receipt.files);
    for (const [path, expected] of Object.entries(manifest.files)) {
      assert.equal(createHash("sha256").update(readFileSync(join(directory, "beebot", path))).digest("hex"), expected);
      assert.ok(!/^(?:\.local|evidence|node_modules|\.snapshots|upstream|design|dist)\//.test(path));
    }
    assert.throws(() => execFileSync(process.execPath, ["scripts/package-source.mjs", "--out", archive], { stdio: "pipe" }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

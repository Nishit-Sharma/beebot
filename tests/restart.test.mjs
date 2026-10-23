import { macSandboxTest } from "./mac-sandbox.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { Effect } from "effect";
import { createHarness } from "../src/harness.mjs";
macSandboxTest(
  "actual worker process crash preserves uncertain attempt and forbids automatic replay",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "bee-crash-"));
    const child = spawn(
      process.execPath,
      ["tests/fixtures/crash-worker.mjs", directory],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Crash fixture timeout"));
      }, 5000);
      child.stdout.on("data", (b) => {
        output += b;
        if (output.includes("ATTEMPT_STARTED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", reject);
    });
    const id = /TASK ([\w-]+)/.exec(output)[1];
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    let calls = 0;
    const h = createHarness({
      directory,
      runner: async () => {
        calls++;
        throw Error("Must not run");
      },
    });
    let t = await Effect.runPromise(h.get("alice", id));
    assert.equal(t.status, "reconciliation_required");
    await Effect.runPromise(h.runNext(id));
    assert.equal(calls, 0);
    t = await Effect.runPromise(
      h.command("alice", id, {
        id: "fresh",
        version: t.version,
        type: "reconcile",
      }),
    );
    assert.equal(t.status, "clarifying");
    assert.equal(t.revision, 2);
    assert.equal(t.plan, null);
    h.close();
  },
);

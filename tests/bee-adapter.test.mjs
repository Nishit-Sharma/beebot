import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createBeeAdapter } from "../src/bee-adapter.mjs";
test("documented Bee argv and raw structural event produce unauthorized context; disconnect exposes gap", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let argv;
  const captures = [];
  const bee = createBeeAdapter({
    spawnProcess: (bin, args) => {
      argv = [bin, ...args];
      return child;
    },
    onCapture: (c) => captures.push(c),
  });
  bee.start();
  assert.deepEqual(argv, [
    "bee",
    "stream",
    "--types",
    "new-utterance",
    "--json",
  ]);
  child.stdout.write(
    '{"utterance":{"text":"Do this now","speaker":"speaker_1"},"conversation_uuid":"sample"}\n',
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(captures.length, 1);
  assert.equal(captures[0].authorized, false);
  assert.equal(captures[0].simulated, false);
  child.emit("exit", 1);
  assert.equal(bee.status().gap, true);
  assert.equal(bee.status().connected, false);
  bee.stop();
});
test("oversized incomplete frames are bounded and old process exit cannot disconnect replacement", () => {
  const children = [];
  const captures = [];
  const bee = createBeeAdapter({
    spawnProcess: () => {
      const c = new EventEmitter();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.kill = () => {};
      children.push(c);
      return c;
    },
    onCapture: (c) => captures.push(c),
  });
  bee.start();
  const old = children[0];
  old.stdout.write("x".repeat(70000));
  old.stdout.write("\n");
  assert.equal(captures.length, 0);
  bee.stop();
  bee.start();
  old.emit("exit", 1);
  assert.equal(bee.status().started, true);
  bee.stop();
  children[1].emit("exit", 0);
});

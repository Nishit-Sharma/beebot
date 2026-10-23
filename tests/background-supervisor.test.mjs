import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackgroundSupervisor } from "../src/background-supervisor.mjs";
import { createExternalAdapters } from "../src/external-adapters.mjs";
const directory = () => mkdtempSync(join(tmpdir(), "bee-supervision-"));
test("scoped stream reconnect backs off, preserves desired intent across restart, and scope expiry stops it", async () => {
  const dir = directory();
  let now = 0,
    scope = true,
    starts = 0,
    stops = 0;
  const stream = {
    status: () => ({ started: false, connected: false }),
    start() {
      starts++;
    },
    stop() {
      stops++;
    },
  };
  const options = {
    directory: dir,
    stream,
    canStream: () => scope,
    poll: async () => ({ attempted: 0, refreshed: 0, failed: 0 }),
    drain: async () => {},
    clock: () => now,
  };
  let s = createBackgroundSupervisor(options);
  await s.startStream();
  assert.equal(starts, 1);
  now = 999;
  await s.tick();
  assert.equal(starts, 1);
  now = 1000;
  await s.tick();
  assert.equal(starts, 2);
  assert.equal(s.status().nextReconnectAt, 3000);
  s.close();
  s = createBackgroundSupervisor(options);
  assert.equal(s.status().desiredStream, true);
  now = 2999;
  await s.tick();
  assert.equal(starts, 2);
  now = 3000;
  await s.tick();
  assert.equal(starts, 3);
  scope = false;
  now = 3001;
  await s.tick();
  assert.equal(s.status().desiredStream, false);
  assert.ok(stops >= 2);
  s.close();
});
test("poll failure remains visible, queue recovery still runs, ticks do not overlap, and owner stop prevents reconnect", async () => {
  let finish,
    drains = 0,
    now = 0,
    starts = 0;
  const s = createBackgroundSupervisor({
    directory: directory(),
    stream: {
      status: () => ({ started: false }),
      start() {
        starts++;
      },
      stop() {},
    },
    canStream: () => true,
    poll: () => new Promise((r) => (finish = r)),
    drain: () => {
      drains++;
    },
    clock: () => now,
  });
  const pending = s.startStream();
  await s.tick();
  assert.equal(starts, 1);
  s.stopStream();
  finish({ attempted: 1, refreshed: 0, failed: 1 });
  await pending;
  assert.equal(drains, 1);
  assert.match(s.status().pollError, /failed/);
  now = 2000;
  await s.tick();
  assert.equal(starts, 1);
  assert.equal(drains, 2);
  s.close();
});
test("external-write contracts bind owner/state/idempotency/expiry while every execution remains disabled", () => {
  const adapters = createExternalAdapters();
  const input = {
    owner: "owner",
    capability: "message.send",
    parameters: { recipientId: "verified-target-id", body: "Draft only" },
    idempotencyKey: "one",
    expectedStateVersion: "version1",
    sourceRefs: ["selected-source:1"],
    expiresAt: 1000,
  };
  const plan = adapters.plan(input, { owner: "owner", now: 0 });
  assert.equal(plan.status, "unavailable");
  assert.ok(plan.approvalDigest);
  assert.ok(adapters.list().every((a) => a.enabled === false));
  assert.throws(
    () => adapters.execute({ ...plan, enabled: true }),
    /ExternalAdapterDisabled/,
  );
  assert.throws(() => adapters.reconcile(plan), /ExternalAdapterDisabled/);
  assert.throws(
    () => adapters.plan(input, { owner: "other", now: 0 }),
    /InvalidExternalPlan/,
  );
  assert.throws(
    () => adapters.plan({ ...input, expiresAt: 0 }, { owner: "owner", now: 0 }),
    /InvalidExternalPlan/,
  );
  assert.throws(
    () =>
      adapters.plan(
        {
          ...input,
          parameters: { recipientId: "x", body: "x", hiddenTool: "shell" },
        },
        { owner: "owner", now: 0 },
      ),
    /InvalidExternalParameters/,
  );
});

test("discovery is off by default and only explicit toggle persists across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bee-discovery-state-"));
  let options;
  const make = () =>
    createBackgroundSupervisor({
      directory,
      stream: { status: () => ({ started: false }), stop() {}, start() {} },
      canStream: () => false,
      poll: async (value) => {
        options = value;
        return {};
      },
      drain: async () => {},
    });
  let s = make();
  assert.equal(s.status().discoveryEnabled, false);
  await s.tick();
  assert.equal(options.discoveryEnabled, false);
  s.setDiscoveryEnabled(true);
  s.close();
  s = make();
  assert.equal(s.status().discoveryEnabled, true);
  await s.tick();
  assert.equal(options.discoveryEnabled, true);
  s.setDiscoveryEnabled(false);
  s.close();
});

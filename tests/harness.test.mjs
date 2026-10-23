import { macSandboxTest } from "./mac-sandbox.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createHarness } from "../src/harness.mjs";
const run = Effect.runPromise;
macSandboxTest(
  "confirmed request produces real failure, exact patch approval and passing evidence after restart",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-harness-"));
    let h = createHarness({ directory: dir });
    let t = await run(
      h.create(
        "alice",
        "When a reminder is due exactly now, show it as due.",
        "fixture",
      ),
    );
    assert.equal(t.status, "clarifying");
    t = await run(
      h.command("alice", t.id, {
        id: "confirm",
        version: t.version,
        type: "confirm",
        inclusive: true,
        excludeCompleted: true,
      }),
    );
    assert.equal(t.status, "acceptance_approval");
    await assert.rejects(
      run(
        h.command("bob", t.id, {
          id: "steal",
          version: t.version,
          type: "approve",
          digest: t.plan.digest,
        }),
      ),
      /Unauthorized/,
    );
    await assert.rejects(
      run(
        h.command("alice", t.id, {
          id: "tamper",
          version: t.version,
          type: "approve",
          digest: "changed",
        }),
      ),
      /ApprovalMismatch/,
    );
    const approval = {
      id: "approve-test",
      version: t.version,
      type: "approve",
      digest: t.plan.digest,
    };
    t = await run(h.command("alice", t.id, approval));
    assert.equal(t.status, "queued");
    assert.deepEqual(await run(h.command("alice", t.id, approval)), t);
    t = await run(h.runNext(t.id));
    assert.equal(t.status, "patch_approval", t.error);
    assert.equal(t.evidence[0].exitCode, 1);
    assert.match(t.evidence[0].output, /expected|false|true/);
    h.close();
    h = createHarness({ directory: dir });
    t = await run(h.get("alice", t.id));
    assert.equal(t.status, "patch_approval");
    t = await run(
      h.command("alice", t.id, {
        id: "patch",
        version: t.version,
        type: "approve",
        digest: t.plan.digest,
      }),
    );
    t = await run(h.runNext(t.id));
    assert.equal(t.status, "review_required");
    assert.equal(
      t.approvalHistory.filter((x) => x.decision === "approved").length,
      2,
    );
    assert.equal(t.approvalHistory.at(-1).plan.kind, "patch");
    assert.match(t.approvalHistory.at(-1).plan.beforeSource, /dueAt < now/);
    assert.equal(t.evidence.at(-1).exitCode, 0);
    assert.equal(t.evidence.at(-1).sandboxed, true);
    t = await run(
      h.command("alice", t.id, {
        id: "accept",
        version: t.version,
        type: "accept",
      }),
    );
    assert.equal(t.status, "completed");
    h.close();
  },
);
async function queued(h, owner = "alice") {
  let t = await run(h.create(owner, "Reminder due exactly now", "fixture"));
  t = await run(
    h.command(owner, t.id, {
      id: crypto.randomUUID(),
      version: t.version,
      type: "confirm",
      inclusive: true,
      excludeCompleted: true,
    }),
  );
  return await run(
    h.command(owner, t.id, {
      id: crypto.randomUUID(),
      version: t.version,
      type: "approve",
      digest: t.plan.digest,
    }),
  );
}
test("steering invalidates old approval; expiry and duplicate command conflict fail closed", async () => {
  let now = 1000;
  const h = createHarness({
    directory: mkdtempSync(join(tmpdir(), "bee-policy-")),
    clock: () => now,
  });
  let t = await run(h.create("alice", "Reminder due now"));
  t = await run(
    h.command("alice", t.id, {
      id: "c",
      version: t.version,
      type: "confirm",
      inclusive: true,
      excludeCompleted: true,
    }),
  );
  const old = t.plan.digest;
  now += 600001;
  await assert.rejects(
    run(
      h.command("alice", t.id, {
        id: "expired",
        version: t.version,
        type: "approve",
        digest: old,
      }),
    ),
    /ApprovalExpired/,
  );
  t = await run(
    h.command("alice", t.id, {
      id: "steer",
      version: t.version,
      type: "steer",
      text: "Reminder due later",
    }),
  );
  assert.equal(t.revision, 2);
  assert.equal(t.plan, null);
  await assert.rejects(
    run(
      h.command("alice", t.id, {
        id: "steer",
        version: t.version,
        type: "steer",
        text: "changed args",
      }),
    ),
    /IdempotencyConflict/,
  );
  h.close();
});
macSandboxTest(
  "pause prevents launch and cancellation interrupts an active adapter without completing task",
  async () => {
    let entered;
    const started = new Promise((r) => (entered = r));
    let calls = 0;
    const h = createHarness({
      directory: mkdtempSync(join(tmpdir(), "bee-control-")),
      runner: async (_, { signal }) => {
        calls++;
        entered();
        return await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(Error("Interrupted")), {
            once: true,
          }),
        );
      },
    });
    let t = await queued(h);
    t = await run(
      h.command("alice", t.id, { id: "p", version: t.version, type: "pause" }),
    );
    await run(h.runNext(t.id));
    assert.equal(calls, 0);
    t = await run(
      h.command("alice", t.id, { id: "r", version: t.version, type: "resume" }),
    );
    const execution = run(h.runNext(t.id));
    await started;
    t = await run(h.get("alice", t.id));
    t = await run(
      h.command("alice", t.id, {
        id: "cancel",
        version: t.version,
        type: "cancel",
      }),
    );
    assert.equal(t.status, "cancelling");
    t = await execution;
    assert.equal(t.status, "cancelled");
    assert.equal(t.evidence.length, 0);
    h.close();
  },
);
macSandboxTest(
  "memory is explicitly saved after review and deletion removes retrieval without crossing owners",
  async () => {
    const h = createHarness({
      directory: mkdtempSync(join(tmpdir(), "bee-memory-")),
      runner: async () => ({
        exitCode: 0,
        output: "PASS fixture",
        sandboxed: false,
      }),
    });
    let t = await queued(h);
    t = await run(h.runNext(t.id));
    t = await run(
      h.command("alice", t.id, {
        id: "accept",
        version: t.version,
        type: "accept",
      }),
    );
    const item = await run(h.memory("alice", "save", { taskId: t.id }));
    assert.equal((await run(h.memory("bob", "list"))).length, 0);
    await assert.rejects(
      run(h.memory("bob", "delete", { id: item.id })),
      /Unauthorized/,
    );
    await run(h.memory("alice", "delete", { id: item.id }));
    assert.deepEqual(await run(h.memory("alice", "list")), []);
    h.close();
  },
);
test("model request is durable before inference, controls cancel it and unsupported proposal cannot execute", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bee-model-"));
  const h = createHarness({ directory: dir });
  const capture = {
    text: "Book a trip",
    authorized: false,
    conversationId: "sample",
  };
  let t = await run(
    h.create("alice", "Book a trip", "bee-live-selected", null, capture, true),
  );
  assert.equal(t.status, "interpretation_queued");
  assert.deepEqual(t.capture, capture);
  let entered;
  const started = new Promise((r) => (entered = r));
  const execution = run(
    h.interpretNext(t.id, async (_, { signal }) => {
      entered();
      return await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Error("Interrupted")), {
          once: true,
        }),
      );
    }),
  );
  await started;
  t = await run(h.get("alice", t.id));
  t = await run(
    h.command("alice", t.id, {
      id: "pause1",
      version: t.version,
      type: "pause",
    }),
  );
  t = await execution;
  t = await run(
    h.command("alice", t.id, {
      id: "pause2",
      version: t.version,
      type: "pause",
    }),
  );
  assert.equal(t.status, "paused");
  assert.equal(t.resumeStatus, "interpretation_queued");
  t = await run(
    h.command("alice", t.id, {
      id: "resume",
      version: t.version,
      type: "resume",
    }),
  );
  t = await run(
    h.interpretNext(t.id, async () => ({
      workflow: "unsupported",
      summary: "Trip planning",
      questions: [],
    })),
  );
  assert.equal(t.status, "clarifying");
  await assert.rejects(
    run(
      h.command("alice", t.id, {
        id: "confirm-unsupported",
        version: t.version,
        type: "confirm",
        inclusive: true,
        excludeCompleted: true,
      }),
    ),
    /UnsupportedCapability/,
  );
  h.close();
});
macSandboxTest(
  "saved context supports bounded edits, provenance revisions and expiry",
  async () => {
    let now = 1000;
    const h = createHarness({
      directory: mkdtempSync(join(tmpdir(), "bee-memory-edit-")),
      clock: () => now,
      runner: async () => ({
        exitCode: 0,
        output: "PASS fixture",
        sandboxed: false,
      }),
    });
    let t = await queued(h);
    t = await run(h.runNext(t.id));
    t = await run(
      h.command("alice", t.id, { id: "a", type: "accept", version: t.version }),
    );
    let m = await run(h.memory("alice", "save", { taskId: t.id }));
    m = await run(
      h.memory("alice", "edit", {
        id: m.id,
        text: "Prefer short agendas",
        expiresAt: 2000,
      }),
    );
    assert.equal(m.revision, 2);
    assert.equal(m.source, t.id);
    assert.equal(
      (await run(h.memory("alice", "list")))[0].text,
      "Prefer short agendas",
    );
    await assert.rejects(
      run(
        h.memory("bob", "edit", { id: m.id, text: "steal", expiresAt: null }),
      ),
      /Unauthorized/,
    );
    now = 2001;
    assert.deepEqual(await run(h.memory("alice", "list")), []);
    h.close();
  },
);

test("accepted companion result saves with provenance, survives reload and preserves expiry on text edit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bee-companion-memory-"));
  let now = 100,
    h = createHarness({ directory, clock: () => now });
  const c = {
    id: "accepted",
    owner: "o",
    status: "completed",
    revision: 3,
    messages: [{ role: "user", text: "Plan locally" }],
    source: { id: "bee-source", revision: 2 },
    artifacts: [
      {
        id: "draft",
        title: "Draft",
        content: "Unique accepted result",
        plan: { revision: 2 },
      },
    ],
    steps: [{ status: "completed", receipt: { artifactId: "draft" } }],
  };
  let m = await run(h.memory("o", "save-conversation", { conversation: c }));
  assert.match(m.text, /Unique accepted result/);
  assert.equal(m.sourceProvenance.bee.id, "bee-source");
  m = await run(
    h.memory("o", "edit", { id: m.id, text: "Edited", expiresAt: 500 }),
  );
  m = await run(h.memory("o", "edit", { id: m.id, text: "Text only" }));
  assert.equal(m.expiresAt, 500);
  h.close();
  h = createHarness({ directory, clock: () => now });
  assert.equal((await run(h.memory("o", "list")))[0].text, "Text only");
  now = 600;
  assert.deepEqual(await run(h.memory("o", "list")), []);
  m = await run(
    h.memory("o", "edit", {
      id: m.id,
      text: "Explicitly clear",
      expiresAt: null,
    }),
  );
  assert.equal(m.expiresAt, null);
  await run(h.memory("o", "delete", { id: m.id }));
  assert.deepEqual(await run(h.memory("o", "list")), []);
  await assert.rejects(
    run(
      h.memory("o", "save-conversation", {
        conversation: { ...c, status: "review_required" },
      }),
    ),
    /ReviewFirst/,
  );
  h.close();
});

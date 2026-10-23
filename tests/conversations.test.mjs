import { buildCompanionRequest } from "../src/proposal-request.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversations } from "../src/conversations.mjs";
import { fixtureCompanion } from "../src/fixture-companion.mjs";
import { DatabaseSync } from "node:sqlite";
import { hash } from "../src/demo-runner.mjs";
import { providerEnvelope, progressContext } from "../src/private-work.mjs";
const directory = () => mkdtempSync(join(tmpdir(), "bee-conversation-"));
test("durable clarification prepares private dependent drafts without approval friction, then asks for result review", async () => {
  const dir = directory();
  let s = createConversations({ directory: dir });
  let c = s.create("a", "Help plan a workshop", "fixture");
  c = await s.run("a", c.id, fixtureCompanion);
  assert.equal(c.status, "clarifying");
  s.close();
  s = createConversations({ directory: dir });
  c = s.get("a", c.id);
  c = s.send("a", c.id, "45 minutes for beginners", c.version);
  c = await s.run("a", c.id, fixtureCompanion);
  assert.equal(c.steps.length, 2);
  assert.ok(c.steps.every((s) => s.status === "completed"));
  assert.equal(c.artifacts.length, 2);
  assert.equal(c.approvals.length, 0);
  assert.ok(
    c.artifacts.every(
      (a) =>
        a.authority === "requested-safe-preparation" &&
        a.ownerApproved === false,
    ),
  );
  assert.equal(c.status, "review_required");
  assert.match(c.artifacts[0].content, /Guided practice/);
  assert.throws(
    () =>
      s.command("b", c.id, { id: "steal", version: c.version, type: "accept" }),
    /Unauthorized/,
  );
  s.close();
});
test("memory edits/deletion revoke pending plans; expiry checked at execution; external capability unavailable", async () => {
  let now = 1;
  let m = { id: "m", text: "Bring paper", revision: 1, expiresAt: 100 };
  const s = createConversations({
    directory: directory(),
    clock: () => now,
    memoryRead: () => m,
  });
  let c = s.create("a", "Plan event", "fixture", ["m"]);
  c = await s.run("a", c.id, async () => ({
    reply: "Draft",
    questions: [],
    steps: [
      {
        id: "draft",
        title: "Checklist",
        capability: "local.document",
        content: "Bring paper",
        dependsOn: [],
      },
    ],
  }));
  m = { ...m, text: "Bring pens", revision: 2 };
  assert.throws(
    () =>
      s.command("a", c.id, {
        id: "bad",
        type: "approve",
        version: c.version,
        digest: c.steps[0].digest,
      }),
    /MemoryChanged/,
  );
  s.revokeMemory("a", "m");
  c = s.get("a", c.id);
  assert.equal(c.status, "source_changed");
  assert.equal(c.steps.length, 0);
  m = null;
  c = s.create("a", "Book venue", "fixture");
  c = await s.run("a", c.id, async () => ({
    reply: "No calendar connected",
    questions: [],
    steps: [
      {
        id: "book",
        title: "Venue",
        capability: "calendar.event",
        content: "Book",
        dependsOn: [],
      },
    ],
  }));
  assert.equal(c.steps[0].status, "unavailable");
  assert.throws(
    () =>
      s.command("a", c.id, {
        id: "external",
        version: c.version,
        type: "approve",
        digest: c.steps[0].digest,
      }),
    /ApprovalMismatch/,
  );
  s.close();
});
test("new instruction invalidates old plan; cancellation cannot be advanced by late provider result", async () => {
  const s = createConversations({ directory: directory() });
  let c = s.create("a", "Draft checklist", "fixture");
  let finish;
  const result = s.run("a", c.id, () => new Promise((r) => (finish = r)));
  c = s.get("a", c.id);
  c = s.command("a", c.id, {
    id: "cancel",
    version: c.version,
    type: "cancel",
  });
  finish({ reply: "late", questions: [], steps: [] });
  await result;
  c = s.get("a", c.id);
  assert.equal(c.status, "cancelled");
  assert.equal(c.messages.length, 1);
  s.close();
});
test("canceling durable source ownership stops all unfinished related revisions and preserves unrelated work", () => {
  const s = createConversations({ directory: directory() });
  const a = s.create("a", "Old source revision", "fixture", [], "workshop", {
      id: "same",
    }),
    b = s.create("a", "New source revision", "fixture", [], "workshop", {
      id: "same",
    }),
    other = s.create("a", "Unrelated task", "fixture", [], "workshop", {
      id: "other",
    });
  s.cancelSource("a", "same");
  assert.equal(s.get("a", a.id).status, "cancelled");
  assert.equal(s.get("a", b.id).status, "cancelled");
  assert.equal(s.get("a", other.id).status, "queued");
  s.close();
});
test("bounded proposal streaming is observable without duplicating every token into permanent audit history", async () => {
  let store,
    seen = false;
  store = createConversations({
    directory: directory(),
    onEvent: (id) => {
      if (store?.get("a", id).stream) seen = true;
    },
  });
  let c = store.create("a", "Draft a private note", "fixture");
  c = await store.run("a", c.id, async ({ onDelta }) => {
    for (let i = 0; i < 50; i++) onDelta("x");
    return {
      reply: "A private note is ready.",
      questions: [],
      steps: [
        {
          id: "note",
          title: "Note",
          capability: "local.document",
          content: "A useful private note based only on the request.",
          dependsOn: [],
        },
      ],
    };
  });
  assert.equal(seen, true);
  assert.equal(
    c.events.some((e) => e.type === "delta"),
    false,
  );
  assert.ok(c.events.length < 10);
  assert.equal(c.status, "review_required");
  store.close();
});
test("source cancellation does not double-advance an already requested running cancellation", async () => {
  const s = createConversations({ directory: directory() });
  let c = s.create("a", "Prepare local work", "fixture", [], "workshop", {
      id: "same",
    }),
    finish;
  const pending = s.run(
    "a",
    c.id,
    () => new Promise((resolve) => (finish = resolve)),
  );
  c = s.get("a", c.id);
  c = s.command("a", c.id, {
    id: "cancel-once",
    type: "cancel",
    version: c.version,
  });
  const version = c.version;
  s.cancelSource("a", "same");
  assert.equal(s.get("a", c.id).version, version);
  finish({ reply: "late", questions: [], steps: [] });
  await pending;
  assert.equal(s.get("a", c.id).status, "cancelled");
  s.close();
});
test("source-dependent work waits durably for fresh context and resumes only with matching selected source", () => {
  let memory = { id: "bee:s", text: "Selected context", revision: 1 };
  const dir = directory();
  let s = createConversations({ directory: dir, memoryRead: () => memory });
  let c = s.create(
    "a",
    "Prepare from selected context",
    "fixture",
    ["bee:s"],
    "workshop",
    { id: "s" },
  );
  c = s.waitForSource("a", c.id);
  assert.equal(c.status, "waiting_source");
  s.close();
  s = createConversations({ directory: dir, memoryRead: () => memory });
  memory = { ...memory, text: "Different context" };
  s.sourceAvailable("a", "s");
  assert.equal(s.get("a", c.id).status, "waiting_source");
  memory = { ...memory, text: "Selected context" };
  s.sourceAvailable("a", "s");
  assert.equal(s.get("a", c.id).status, "queued");
  c = s.command("a", c.id, {
    id: "cancel-wait",
    type: "cancel",
    version: s.get("a", c.id).version,
  });
  s.sourceAvailable("a", "s");
  assert.equal(s.get("a", c.id).status, "cancelled");
  s.close();
});
test("approved source-dependent action resumes only after fresh source and still honors approval expiry", async () => {
  let now = 1,
    memory = { id: "bee:s", text: "Selected context", revision: 1 };
  const dir = directory();
  let s = createConversations({
    directory: dir,
    clock: () => now,
    memoryRead: () => memory,
  });
  let c = s.create(
    "a",
    "Confirm the selected policy",
    "fixture",
    ["bee:s"],
    "policy",
    { id: "s" },
  );
  c = await s.run("a", c.id, fixtureCompanion);
  c = s.send("a", c.id, "Confirmed threshold 100 inclusive.", c.version);
  c = await s.run("a", c.id, fixtureCompanion);
  c = s.command("a", c.id, {
    id: "approve-before-outage",
    type: "approve",
    version: c.version,
    digest: c.steps[0].digest,
  });
  c = s.waitForSource("a", c.id, true);
  assert.equal(c.status, "waiting_source_action");
  s.close();
  s = createConversations({
    directory: dir,
    clock: () => now,
    memoryRead: () => memory,
  });
  memory = null;
  s.sourceAvailable("a", "s");
  assert.equal(s.get("a", c.id).status, "waiting_source_action");
  memory = { id: "bee:s", text: "Selected context", revision: 1 };
  now = 700000;
  s.sourceAvailable("a", "s");
  assert.equal(s.get("a", c.id).status, "action_queued");
  c = await s.runAction("a", c.id);
  assert.equal(c.status, "failed");
  assert.equal(c.error, "ApprovalExpired");
  assert.equal(c.actionEvidence, undefined);
  s.close();
});

test("runner failure marks the action step failed and permits a fresh plan request", async () => {
  const s = createConversations({
    directory: directory(),
    runSandbox: async () => {
      throw Error("SandboxUnavailable");
    },
  });
  let c = s.create("a", "Discount threshold", "fixture", [], "policy");
  c = await s.run("a", c.id, fixtureCompanion);
  c = s.send("a", c.id, "Confirmed threshold 100 inclusive", c.version);
  c = await s.run("a", c.id, fixtureCompanion);
  c = s.command("a", c.id, {
    id: "approve",
    version: c.version,
    type: "approve",
    digest: c.steps[0].digest,
  });
  c = await s.runAction("a", c.id);
  assert.equal(c.status, "failed");
  assert.equal(c.steps[0].status, "failed");
  assert.equal(c.steps[0].error, "The sandbox couldn't run the test.");
  c = s.send("a", c.id, "Please propose a fresh plan.", c.version);
  assert.equal(c.status, "queued");
  s.close();
});

test("restart revokes in-flight plans, retains completed evidence and honors pause/cancel intent", async () => {
  for (const [before, after] of [
    ["thinking", "interrupted"],
    ["acting", "interrupted"],
    ["pausing", "paused"],
    ["cancelling", "cancelled"],
  ]) {
    const dir = directory();
    let s = createConversations({ directory: dir });
    let c = s.create("a", "Prepare locally; do not publish", "fixture");
    c = await s.run("a", c.id, fixtureCompanion);
    s.close();
    const db = new DatabaseSync(join(dir, "conversations.sqlite"));
    c.status = before;
    c.stream = "partial output";
    c.steps = [
      {
        id: "old",
        digest: "old-digest",
        status: "approval_required",
        revision: c.revision,
        expiresAt: Date.now() + 600000,
      },
      { id: "running", status: "running" },
      {
        id: "saved",
        status: "completed",
        receipt: { artifactId: "saved-artifact" },
      },
    ];
    c.artifacts = [
      {
        id: "saved-artifact",
        content: "Approved prior draft",
        digest: hash("Approved prior draft"),
      },
    ];
    c.approvals = [{ decision: "approved", plan: { id: "running" } }];
    c.actionEvidence = [
      { stepId: "running", revision: c.revision, outputHash: "prior-evidence" },
    ];
    db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
      JSON.stringify(c),
      c.id,
    );
    db.close();
    s = createConversations({ directory: dir });
    const recovered = s.get("a", c.id);
    assert.equal(recovered.status, after);
    assert.equal(recovered.revision, c.revision + 1);
    assert.equal(recovered.stream, "");
    assert.deepEqual(
      recovered.steps.map((step) => step.id),
      ["saved"],
    );
    assert.deepEqual(recovered.artifacts, c.artifacts);
    assert.deepEqual(recovered.approvals, c.approvals);
    assert.deepEqual(recovered.actionEvidence, c.actionEvidence);
    assert.throws(
      () =>
        s.command("a", c.id, {
          id: "stale-approval",
          type: "approve",
          version: recovered.version,
          digest: "old-digest",
        }),
      /ApprovalMismatch/,
    );
    assert.deepEqual(await s.runAction("a", c.id), recovered);
    if (after === "interrupted") {
      const fresh = s.send(
        "a",
        c.id,
        "Reconcile and propose a fresh plan",
        recovered.version,
      );
      assert.equal(fresh.status, "queued");
      assert.equal(fresh.steps.length, 0);
    }
    s.close();
  }
});

test("command idempotency binds conversation identity separately from the command id", () => {
  const s = createConversations({ directory: directory() });
  const first = s.create("a", "First private task", "fixture");
  const second = s.create("a", "Second private task", "fixture");
  const command = { id: "same-command", version: first.version, type: "pause" };
  const result = s.command("a", first.id, command);
  assert.deepEqual(s.command("a", first.id, command), result);
  assert.equal(first.version, second.version);
  assert.throws(
    () => s.command("a", second.id, command),
    /IdempotencyConflict/,
  );
  assert.deepEqual(s.get("a", second.id), second);
  s.close();
});

test("completed and cancelled conversations reject new pause/cancel commands but allow exact replay", async () => {
  const s = createConversations({ directory: directory() });
  let c = s.create("a", "Prepare a note", "fixture");
  c = await s.run("a", c.id, async () => ({
    reply: "Ready",
    questions: [],
    steps: [
      {
        id: "note",
        title: "Note",
        capability: "local.document",
        content: "Private draft for review",
        dependsOn: [],
      },
    ],
  }));
  c = s.command("a", c.id, {
    id: "accept",
    type: "accept",
    version: c.version,
  });
  for (const type of ["pause", "cancel"]) {
    assert.throws(
      () =>
        s.command("a", c.id, {
          id: "closed-" + type,
          type,
          version: c.version,
        }),
      /ConversationClosed/,
    );
    assert.deepEqual(s.get("a", c.id), c);
  }
  let cancelled = s.create("a", "Another note", "fixture");
  const command = { id: "cancel", type: "cancel", version: cancelled.version };
  cancelled = s.command("a", cancelled.id, command);
  assert.deepEqual(s.command("a", cancelled.id, command), cancelled);
  for (const type of ["pause", "cancel"])
    assert.throws(
      () =>
        s.command("a", cancelled.id, {
          id: "cancelled-" + type,
          type,
          version: cancelled.version,
        }),
      /ConversationClosed/,
    );
  s.close();
});

test("send measures the exact provider envelope at the byte limit without dropping saved constraints", () => {
  const s = createConversations({
    directory: directory(),
    clock: () => 1,
    memoryRead: () => ({ text: "Saved constraint ".repeat(1000) }),
  });
  let c = s.create("a", "Retain context", "fixture", ["m"]);
  const input = {
    messages: [...c.messages, { role: "user", text: "", at: 1 }],
    memory: c.memorySources.map(({ id, text }) => ({ id, text })),
    artifacts: progressContext(c),
    intentChanges: [],
  };
  const available = 32000 - buildCompanionRequest(input).inputBytes;
  assert.ok(available > 0 && available <= 8192);
  c = s.send("a", c.id, "x".repeat(available), c.version);
  input.messages = c.messages;
  assert.equal(buildCompanionRequest(input).inputBytes, 32000);
  assert.throws(
    () => s.send("a", c.id, "another correction", c.version),
    /ConversationContextBudgetExceeded/,
  );
  assert.deepEqual(s.get("a", c.id), c);
  s.close();
});

test("large existing artifacts cause rejection before queuing a correction instead of silent truncation", async () => {
  const s = createConversations({ directory: directory() });
  let c = s.create("a", "Draft full private documents", "fixture");
  const proposal = async () => ({
    reply: "Drafts",
    questions: [],
    steps: [0, 1].map((i) => ({
      id: "draft" + i,
      title: "Draft " + i,
      capability: "local.document",
      content: "x".repeat(8000),
      dependsOn: [],
    })),
  });
  c = await s.run("a", c.id, proposal);
  c = s.send("a", c.id, "Prepare another version", c.version);
  c = await s.run("a", c.id, proposal);
  assert.equal(progressContext(c).length, 4);
  assert.throws(
    () => s.send("a", c.id, "Correct the first draft", c.version),
    /ConversationContextBudgetExceeded/,
  );
  assert.deepEqual(s.get("a", c.id), c);
  s.close();
});

test("owner-validated replacements reach provider context while separate constraints and all messages remain", async () => {
  const s = createConversations({ directory: directory() });
  let c = s.create(
    "owner",
    "Keep all work local; no accounts or publication",
    "fixture",
  );
  c = s.send("owner", c.id, "Prepare a long guide", c.version);
  c = s.send(
    "owner",
    c.id,
    "Prepare a concise feature list instead",
    c.version,
  );
  const requestDigest = hash(c.messages[1].text);
  assert.throws(
    () =>
      s.command("owner", c.id, {
        id: "forged",
        type: "replace-request",
        version: c.version,
        requestNumber: 2,
        replacementRequestNumber: 3,
        requestDigest: "wrong",
      }),
    /InvalidOwnerReplacement/,
  );
  c = s.command("owner", c.id, {
    id: "replacement",
    type: "replace-request",
    version: c.version,
    requestNumber: 2,
    replacementRequestNumber: 3,
    requestDigest,
  });
  let called = false;
  c = await s.run("owner", c.id, async ({ messages, intentChanges }) => {
    called = true;
    assert.equal(messages.length, 3);
    assert.match(messages[0].text, /no accounts or publication/);
    assert.equal(messages[1].text, "Prepare a long guide");
    assert.deepEqual(intentChanges, [
      {
        type: "replace-request",
        source: "owner-command",
        scope: "entire-message",
        requestNumber: 2,
        replacementRequestNumber: 3,
        requestDigest,
        replacementRequestDigest: hash(messages[2].text),
        actor: "owner",
        at: c.intentChanges[0].at,
      },
    ]);
    return { reply: "Local feature list next", questions: [], steps: [] };
  });
  assert.equal(called, true);
  assert.equal(c.status, "ready");
  s.close();
});

test("source revocation durably blocks replacement, pause/resume and inference despite retained private context", async () => {
  for (const changedMemory of [null, { text: "Edited selected source" }]) {
    const dir = directory();
    let memory = { text: "PRIVATE_SYNTHETIC_MARKER" };
    let s = createConversations({ directory: dir, memoryRead: () => memory });
    let c = s.create(
      "owner",
      "Prepare locally from selected context",
      "fixture",
      ["m"],
    );
    c = await s.run("owner", c.id, async () => ({
      reply: "PRIVATE_SYNTHETIC_MARKER in retained response",
      questions: [],
      steps: [
        {
          id: "note",
          title: "Private note",
          capability: "local.document",
          content: "PRIVATE_SYNTHETIC_MARKER in retained draft",
          dependsOn: [],
        },
      ],
    }));
    c = s.send(
      "owner",
      c.id,
      "Replace the note with a concise list",
      c.version,
    );
    memory = changedMemory;
    s.revokeMemory("owner", "m");
    c = s.get("owner", c.id);
    assert.equal(c.sourceRevoked, true);
    assert.equal(c.memorySources.length, 0);
    assert.match(JSON.stringify(c.artifacts), /PRIVATE_SYNTHETIC_MARKER/);
    const replacement = {
      id: "replace",
      type: "replace-request",
      version: c.version,
      requestNumber: 1,
      replacementRequestNumber: 2,
      requestDigest: hash(c.messages[0].text),
    };
    assert.throws(
      () => s.command("owner", c.id, replacement),
      /SourceChangedStartNewConversation/,
    );
    for (const type of ["pause", "resume"])
      assert.throws(
        () => s.command("owner", c.id, { id: type, type, version: c.version }),
        /SourceChangedStartNewConversation/,
      );
    assert.throws(
      () => s.send("owner", c.id, "Continue", c.version),
      /SourceChangedStartNewConversation/,
    );
    s.close();
    // A preexisting paused/queued state cannot erase the independent revocation marker.
    const db = new DatabaseSync(join(dir, "conversations.sqlite"));
    c.status = "pausing";
    db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
      JSON.stringify(c),
      c.id,
    );
    db.close();
    s = createConversations({ directory: dir, memoryRead: () => memory });
    c = s.get("owner", c.id);
    assert.equal(c.sourceRevoked, true);
    assert.equal(c.status, "source_changed");
    assert.throws(
      () =>
        s.command("owner", c.id, {
          id: "resume-after-restart",
          type: "resume",
          version: c.version,
        }),
      /SourceChangedStartNewConversation/,
    );
    s.close();
    const seed = new DatabaseSync(join(dir, "conversations.sqlite"));
    c.status = "queued";
    seed
      .prepare("UPDATE conversations SET data=? WHERE id=?")
      .run(JSON.stringify(c), c.id);
    seed.close();
    s = createConversations({ directory: dir, memoryRead: () => memory });
    let calls = 0;
    c = await s.run("owner", c.id, async () => {
      calls++;
      return { reply: "Must never run", questions: [], steps: [] };
    });
    assert.equal(calls, 0);
    assert.equal(c.status, "source_changed");
    assert.equal(c.sourceRevoked, true);
    s.close();
  }
});

test("legacy revocation evidence restores the durable guard even after the visible status was changed", () => {
  const dir = directory();
  let s = createConversations({
    directory: dir,
    memoryRead: () => ({ text: "Selected private context" }),
  });
  let c = s.create("owner", "Use selected context", "fixture", ["m"]);
  s.revokeMemory("owner", "m");
  c = s.get("owner", c.id);
  s.close();
  delete c.sourceRevoked;
  c.status = "paused";
  const db = new DatabaseSync(join(dir, "conversations.sqlite"));
  db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
    JSON.stringify(c),
    c.id,
  );
  db.close();
  s = createConversations({ directory: dir });
  c = s.get("owner", c.id);
  assert.equal(c.sourceRevoked, true);
  assert.throws(
    () =>
      s.command("owner", c.id, {
        id: "legacy-resume",
        type: "resume",
        version: c.version,
      }),
    /SourceChangedStartNewConversation/,
  );
  s.close();
});

test("resume rejects an oversized full envelope and a legacy oversized queue cannot poison unrelated work", async () => {
  const dir = directory();
  let s = createConversations({ directory: dir });
  let c = s.create("owner", "Prepare full private documents", "fixture");
  const proposal = async () => ({
    reply: "Drafts ready",
    questions: [],
    steps: [0, 1].map((i) => ({
      id: "draft" + i,
      title: "Private draft",
      capability: "local.document",
      content: "x".repeat(3500),
      dependsOn: [],
    })),
  });
  for (let turn = 0; turn < 3; turn++) {
    if (turn)
      c = s.send("owner", c.id, "Prepare another complete version", c.version);
    c = await s.run("owner", c.id, proposal);
  }
  assert.equal(c.artifacts.length, 6);
  c = s.command("owner", c.id, {
    id: "pause-large",
    type: "pause",
    version: c.version,
  });
  assert.throws(
    () =>
      s.command("owner", c.id, {
        id: "resume-large",
        type: "resume",
        version: c.version,
      }),
    /ConversationContextBudgetExceeded/,
  );
  assert.throws(
    () =>
      s.command("owner", c.id, {
        id: "replace-large",
        type: "replace-request",
        version: c.version,
        requestNumber: 1,
        replacementRequestNumber: 2,
        requestDigest: hash(c.messages[0].text),
      }),
    /ConversationContextBudgetExceeded/,
  );
  assert.deepEqual(s.get("owner", c.id), c);
  const oversizedId = c.id;
  const unrelated = s.create(
    "owner",
    "Unrelated small private task",
    "fixture",
  );
  s.close();
  const db = new DatabaseSync(join(dir, "conversations.sqlite"));
  c.status = "queued";
  db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
    JSON.stringify(c),
    c.id,
  );
  db.close();
  s = createConversations({ directory: dir });
  let calls = 0;
  for (;;) {
    const next = s
      .list("owner")
      .toReversed()
      .find((task) => task.status === "queued");
    if (!next) break;
    await s.run("owner", next.id, async () => {
      calls++;
      assert.equal(next.id, unrelated.id);
      return { reply: "Small task considered", questions: [], steps: [] };
    });
  }
  const failed = s.get("owner", oversizedId);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /ConversationContextBudgetExceeded/);
  assert.ok(failed.events.some((event) => event.type === "failure"));
  assert.equal(calls, 1);
  assert.equal(s.get("owner", unrelated.id).status, "ready");
  s.close();
  const waitingDb = new DatabaseSync(join(dir, "conversations.sqlite"));
  failed.status = "waiting_source";
  failed.source = { id: "fresh-source" };
  waitingDb
    .prepare("UPDATE conversations SET data=? WHERE id=?")
    .run(JSON.stringify(failed), failed.id);
  waitingDb.close();
  s = createConversations({ directory: dir });
  s.sourceAvailable("owner", "fresh-source");
  assert.equal(s.get("owner", oversizedId).status, "failed");
  assert.match(
    s.get("owner", oversizedId).error,
    /ConversationContextBudgetExceeded/,
  );
  s.close();
});

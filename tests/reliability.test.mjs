import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConversations } from "../src/conversations.mjs";
const directory = () => mkdtempSync(join(tmpdir(), "bee-reliability-"));
const draft = () => ({
  reply: "Prepared",
  questions: [],
  steps: [
    {
      id: "draft",
      title: "Workshop",
      capability: "local.document",
      content: "A private workshop plan",
      dependsOn: [],
    },
  ],
});

test("memory expiring during a provider turn revokes publication and every fresh retry across restart", async () => {
  let now = 10,
    calls = 0;
  const dir = directory();
  const options = {
    directory: dir,
    clock: () => now,
    memoryRead: () => ({
      text: "Synthetic retained constraint",
      revision: 1,
      expiresAt: 20,
    }),
  };
  let store = createConversations(options);
  let c = store.create("owner", "Prepare a workshop", "fixture", ["memory"]);
  c = await store.run("owner", c.id, async () => {
    calls++;
    now = 21;
    return draft();
  });
  assert.equal(c.status, "source_changed");
  assert.equal(c.sourceRevoked, true);
  assert.equal(c.artifacts.length, 0);
  assert.equal(c.messages.filter((m) => m.role === "assistant").length, 0);
  assert.equal(c.steps.length, 0);
  assert.ok(c.events.some((e) => e.type === "revocation"));
  store.close();
  store = createConversations(options);
  c = store.get("owner", c.id);
  assert.throws(
    () => store.send("owner", c.id, "Retry", c.version),
    /SourceChanged/,
  );
  for (const type of ["resume", "pause", "replace-request"])
    assert.throws(
      () =>
        store.command("owner", c.id, { id: type, type, version: c.version }),
      /SourceChanged/,
    );
  await store.run("owner", c.id, async () => {
    calls++;
    return draft();
  });
  assert.equal(calls, 1);
  store.close();
});

test("elapsed memory expiry rejects idle acceptance and instruction before another queue is created", async () => {
  for (const operation of ["accept", "send"]) {
    let now = 10;
    const store = createConversations({
      directory: directory(),
      clock: () => now,
      memoryRead: () => ({ text: "Synthetic scope", expiresAt: 20 }),
    });
    let c = store.create("owner", "Prepare a private plan", "fixture", [
      "memory",
    ]);
    c = await store.run("owner", c.id, async () => draft());
    assert.equal(c.status, "review_required");
    const artifact = structuredClone(c.artifacts[0]);
    now = 21;
    assert.throws(
      () =>
        operation === "send"
          ? store.send("owner", c.id, "Revise it", c.version)
          : store.command("owner", c.id, {
              id: "accept",
              type: "accept",
              version: c.version,
            }),
      /MemoryChanged/,
    );
    c = store.get("owner", c.id);
    assert.equal(c.status, "source_changed");
    assert.equal(c.sourceRevoked, true);
    assert.equal(c.steps.length, 0);
    assert.deepEqual(
      c.artifacts[0],
      artifact,
      "historical prepared output is preserved",
    );
    store.close();
  }
});

test("expired memory in a late stream delta cannot remain visible or publish a result", async () => {
  let now = 10;
  const store = createConversations({
    directory: directory(),
    clock: () => now,
    memoryRead: () => ({ text: "Synthetic scope", expiresAt: 20 }),
  });
  let c = store.create("owner", "Prepare a plan", "fixture", ["memory"]);
  c = await store.run("owner", c.id, async ({ onDelta }) => {
    onDelta("Earlier temporary text");
    now = 21;
    onDelta("Expired text");
    return draft();
  });
  assert.equal(c.status, "source_changed");
  assert.equal(c.stream, "");
  assert.equal(c.artifacts.length, 0);
  store.close();
});

import { createBeeContext } from "../src/bee-context.mjs";
import { discoverBeeConversations } from "../src/bee-discovery.mjs";
import { DatabaseSync } from "node:sqlite";
const beeSource = {
  reference: "conversation:77",
  conversationId: "77",
  conversationUuid: "uuid77",
  text: "Synthetic workshop context",
  transcriptDigest: "digest77",
  transport: "official-cli-library",
};

test("cleared followed sources stay tombstoned during discovery and explicit reread cannot restore old follow authority", async () => {
  const dir = directory();
  let inbox = createBeeContext({ directory: dir });
  const source = inbox.ingest(beeSource);
  inbox.follow(source.id, "Prepare a private plan", "codex");
  inbox.remove(source.id);
  inbox.close();
  inbox = createBeeContext({ directory: dir });
  let reads = 0;
  const result = await discoverBeeConversations({
    inbox,
    bee: {
      listRecentConversations: async () => [{ id: 77 }],
      readConversation: async () => {
        reads++;
        return beeSource;
      },
    },
  });
  assert.equal(result.added, 0);
  assert.equal(reads, 0);
  assert.equal(inbox.list().length, 0);
  const restored = inbox.ingest(beeSource);
  assert.equal(restored.authorized, false);
  assert.equal(inbox.scopes().length, 0);
  inbox.close();
});

test("failed reserved recovery is isolated, retains intent and lets other claims recover", () => {
  const dir = directory();
  let inbox = createBeeContext({ directory: dir });
  const bad = inbox.ingest(beeSource),
    good = inbox.ingest({
      ...beeSource,
      reference: "conversation:78",
      conversationId: "78",
    });
  let invalidMakes = 0;
  assert.throws(
    () =>
      inbox.claim(
        bad.id,
        bad.revision,
        () => {
          invalidMakes++;
          return "must-not-run";
        },
        { goal: "🌿".repeat(3000) },
      ),
    /ConversationBudgetExceeded/,
  );
  assert.equal(invalidMakes, 0);
  assert.equal(inbox.get(bad.id).approvedText, undefined);
  const before = new DatabaseSync(join(dir, "bee-context.sqlite"));
  assert.equal(
    before.prepare("SELECT count(*) AS n FROM reservations").get().n,
    0,
  );
  before.close();
  for (const source of [bad, good])
    assert.throws(
      () =>
        inbox.claim(
          source.id,
          source.revision,
          () => {
            throw Error("SyntheticCrash");
          },
          { goal: source.id },
        ),
      /SyntheticCrash/,
    );
  inbox.close();
  inbox = createBeeContext({ directory: dir });
  let calls = 0;
  const recovered = inbox.reconcileClaims((source, id) => {
    calls++;
    if (source.id === bad.id) throw Error("ContextBudgetExceeded");
    return id;
  });
  assert.equal(calls, 2);
  assert.equal(recovered.length, 2);
  assert.equal(
    inbox.get(bad.id).claimRecoveryError.code,
    "ClaimRecoveryFailed",
  );
  assert.ok(recovered.some((result) => result.error === "ClaimRecoveryFailed"));
  assert.throws(
    () =>
      inbox.claim(
        bad.id,
        bad.revision,
        () => {
          throw Error("must not run");
        },
        { goal: "Changed intent" },
      ),
    /DifferentIntent/,
  );
  inbox.close();
  const db = new DatabaseSync(join(dir, "bee-context.sqlite"));
  const row = db
    .prepare("SELECT * FROM reservations WHERE state='failed'")
    .get();
  assert.equal(JSON.parse(row.intent).goal, bad.id);
  db.close();
});

import { createBackgroundSupervisor } from "../src/background-supervisor.mjs";
test("unreadable stored state is preserved and stops startup before recovery mutations or background work", () => {
  for (const invalid of ["{", "{}", "null"]) {
    const dir = directory();
    let store = createConversations({ directory: dir });
    const c = store.create("owner", "Keep this task", "fixture");
    store.close();
    let db = new DatabaseSync(join(dir, "conversations.sqlite"));
    db.prepare("UPDATE conversations SET data=? WHERE id=?").run(invalid, c.id);
    db.close();
    assert.throws(
      () => createConversations({ directory: dir }),
      /StoredConversationStateUnreadable.*kept unchanged/,
    );
    db = new DatabaseSync(join(dir, "conversations.sqlite"));
    assert.equal(
      db.prepare("SELECT data FROM conversations WHERE id=?").get(c.id).data,
      invalid,
    );
    db.close();
    let stops = 0;
    const options = {
      directory: dir,
      stream: {
        stop() {
          stops++;
        },
      },
      canStream: () => false,
      poll: async () => {
        throw Error("must not run");
      },
      drain: async () => {
        throw Error("must not run");
      },
    };
    const supervisor = createBackgroundSupervisor(options);
    supervisor.setDiscoveryEnabled(false);
    supervisor.close();
    stops = 0;
    db = new DatabaseSync(join(dir, "supervisor.sqlite"));
    db.prepare("UPDATE state SET data=? WHERE id=1").run(invalid);
    db.close();
    assert.throws(
      () => createBackgroundSupervisor(options),
      /StoredSupervisorStateUnreadable.*kept unchanged/,
    );
    assert.equal(stops, 0);
    db = new DatabaseSync(join(dir, "supervisor.sqlite"));
    assert.equal(
      db.prepare("SELECT data FROM state WHERE id=1").get().data,
      invalid,
    );
    db.close();
  }
});

test("expired saved memory filtered by its adapter revokes waiting work rather than looking like a Bee outage", () => {
  let now = 10;
  const store = createConversations({
    directory: directory(),
    clock: () => now,
    memoryRead: (_, id) =>
      id === "bee:s"
        ? { text: "Selected Bee context" }
        : now < 20
          ? { text: "Saved constraint", expiresAt: 20 }
          : undefined,
  });
  let c = store.create(
    "owner",
    "Prepare a plan",
    "fixture",
    ["bee:s", "saved"],
    "workshop",
    { id: "s" },
  );
  c = store.waitForSource("owner", c.id);
  now = 21;
  store.sourceAvailable("owner", "s");
  c = store.get("owner", c.id);
  assert.equal(c.status, "source_changed");
  assert.equal(c.sourceRevoked, true);
  assert.ok(!c.memorySources.some((s) => s.id === "saved"));
  store.close();
});

import { fixtureCompanion } from "../src/fixture-companion.mjs";
test("same-text memory revision change revokes an approved action before its runner starts", async () => {
  let revision = 1,
    executions = 0;
  const store = createConversations({
    directory: directory(),
    memoryRead: () => ({ text: "Synthetic policy scope", revision }),
    runSandbox: async () => {
      executions++;
      return { exitCode: 1 };
    },
  });
  let c = store.create(
    "owner",
    "Check the discount policy",
    "fixture",
    ["memory"],
    "policy",
  );
  c = await store.run("owner", c.id, fixtureCompanion);
  c = store.send("owner", c.id, "Confirmed threshold 100 inclusive", c.version);
  c = await store.run("owner", c.id, fixtureCompanion);
  c = store.command("owner", c.id, {
    id: "approve",
    type: "approve",
    version: c.version,
    digest: c.steps[0].digest,
  });
  revision = 2;
  c = await store.runAction("owner", c.id);
  assert.equal(c.status, "source_changed");
  assert.equal(executions, 0);
  assert.equal(c.actionEvidence, undefined);
  assert.equal(c.steps.length, 0);
  store.close();
});

test("memory expiring during an authorized action retains its attempted evidence but revokes follow-up plans", async () => {
  let now = 1,
    executions = 0;
  const store = createConversations({
    directory: directory(),
    clock: () => now,
    memoryRead: () =>
      now < 100 ? { text: "Synthetic scope", expiresAt: 100 } : undefined,
    runSandbox: async () => {
      executions++;
      now = 101;
      return {
        exitCode: 1,
        outputHash: "synthetic-evidence",
        sourceHash: "synthetic-source",
      };
    },
  });
  let c = store.create(
    "owner",
    "Check the discount policy",
    "fixture",
    ["memory"],
    "policy",
  );
  c = await store.run("owner", c.id, fixtureCompanion);
  c = store.send("owner", c.id, "Confirmed threshold 100 inclusive", c.version);
  c = await store.run("owner", c.id, fixtureCompanion);
  c = store.command("owner", c.id, {
    id: "approve",
    type: "approve",
    version: c.version,
    digest: c.steps[0].digest,
  });
  c = await store.runAction("owner", c.id);
  assert.equal(c.status, "source_changed");
  assert.equal(executions, 1);
  assert.equal(c.actionEvidence.length, 1);
  assert.equal(c.actionEvidence[0].outputHash, "synthetic-evidence");
  assert.equal(c.steps.length, 0);
  assert.throws(
    () => store.send("owner", c.id, "Retry", c.version),
    /SourceChanged/,
  );
  store.close();
});

import { conversationAnnouncement } from "../public/visuals.mjs";
test("pending cancellation announcement distinguishes requested interruption from confirmed cancellation", () => {
  assert.equal(
    conversationAnnouncement("cancelling"),
    "Cancellation requested. Waiting for interruption; unused plans revoked.",
  );
  assert.equal(
    conversationAnnouncement("cancelled"),
    "Conversation cancelled.",
  );
  assert.notEqual(
    conversationAnnouncement("cancelling"),
    conversationAnnouncement("cancelled"),
  );
  assert.match(conversationAnnouncement("pausing"), /Pause requested/);
});

import * as ui from "../public/visuals.mjs";
test("clearing a source resets its local Follow choice while preserving other drafts and never granting authority", () => {
  const drafts = new Map([
    ["cleared", { goal: "Prepare a private plan", follow: true }],
    ["other", { goal: "Keep this unsent request", follow: true }],
  ]);
  const checkbox = { checked: true };
  const article = { querySelector: () => checkbox };
  assert.equal(typeof ui.resetInboxFollowChoice, "function");
  ui.resetInboxFollowChoice(drafts, "cleared", article);
  assert.equal(checkbox.checked, false);
  assert.deepEqual(drafts.get("cleared"), {
    goal: "Prepare a private plan",
    follow: false,
  });
  assert.deepEqual(drafts.get("other"), {
    goal: "Keep this unsent request",
    follow: true,
  });
  const rereadCheckbox = { checked: false };
  rereadCheckbox.checked = drafts.get("cleared").follow;
  assert.equal(rereadCheckbox.checked, false);
  drafts.set("cleared", { ...drafts.get("cleared"), follow: true });
  checkbox.checked = true;
  ui.resetRemovedInboxFollowChoices(
    drafts,
    new Map([["cleared", article]]),
    [],
  );
  assert.equal(
    checkbox.checked,
    false,
    "last source removal resets before rendering the empty inbox",
  );
  assert.equal(drafts.get("cleared").follow, false);
  assert.equal(drafts.get("other").follow, true);
  drafts.set("cleared", { ...drafts.get("cleared"), follow: true });
  ui.resetRemovedInboxFollowChoices(drafts, new Map([["cleared", article]]), [
    { id: "cleared" },
  ]);
  assert.equal(
    drafts.get("cleared").follow,
    true,
    "an unchanged source keeps its unsent choice",
  );
  const dir = directory(),
    inbox = createBeeContext({ directory: dir });
  const source = inbox.ingest(beeSource);
  inbox.follow(source.id, "Private plan", "codex");
  inbox.remove(source.id);
  inbox.ingest(beeSource);
  assert.equal(inbox.scopes().length, 0);
  drafts.set("cleared", { ...drafts.get("cleared"), follow: true });
  assert.equal(
    inbox.scopes().length,
    0,
    "even newly checking the box is only a choice, not consent or authority",
  );
  inbox.close();
});

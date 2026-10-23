import { macSandboxTest } from "./mac-sandbox.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBeeContext,
  changedCursor,
  beePolicyFixture,
} from "../src/bee-context.mjs";
import { createBeeSourceClient } from "../src/bee-client.mjs";
import { createConversations } from "../src/conversations.mjs";
import { fixtureCompanion } from "../src/fixture-companion.mjs";
const dir = () => mkdtempSync(join(tmpdir(), "bee-context-"));
test("Bee context requires selection, deduplicates task creation across restart and revokes changed/deleted sources", async () => {
  const directory = dir();
  let conversations;
  let inbox = createBeeContext({
    directory,
    onRevoke: (id) => conversations?.revokeMemory("o", id),
  });
  conversations = createConversations({
    directory,
    memoryRead: (_, id) => inbox.memory(id),
  });
  let s = inbox.ingest(beePolicyFixture);
  assert.equal(s.authorized, false);
  assert.equal(conversations.list("o").length, 0);
  const make = (s, taskId) =>
    conversations.create(
      "o",
      "Test this requirement",
      "fixture",
      ["bee:" + s.id],
      "policy",
      { id: s.id, revision: s.revision, simulated: true },
      taskId,
    ).id;
  let claim = inbox.claim(s.id, s.revision, make);
  let c = await conversations.run("o", claim.conversationId, fixtureCompanion);
  assert.equal(c.status, "clarifying");
  inbox.close();
  inbox = createBeeContext({
    directory,
    onRevoke: (id) => conversations.revokeMemory("o", id),
  });
  assert.equal(inbox.claim(s.id, s.revision, make).duplicate, true);
  c = conversations.send(
    "o",
    c.id,
    "Yes, exactly 100 is included and lower totals are unchanged.",
    c.version,
  );
  c = await conversations.run("o", c.id, fixtureCompanion);
  assert.equal(c.status, "plan_review");
  const plan = c.steps[0];
  inbox.ingest({
    ...beePolicyFixture,
    text: "Corrected threshold requirement",
  });
  assert.equal(conversations.get("o", c.id).status, "source_changed");
  assert.throws(
    () =>
      conversations.command("o", c.id, {
        id: "stale",
        type: "approve",
        version: c.version,
        digest: plan.digest,
      }),
    /StaleRevision/,
  );
  inbox.remove(s.id);
  assert.equal(inbox.memory("bee:" + s.id), null);
  assert.throws(() => inbox.claim(s.id, s.revision, make), /SourceChanged/);
  conversations.close();
  inbox.close();
});
test("official wrapper event.data is the raw documented payload, not an event discriminator", async () => {
  const seen = [],
    deleted = [];
  const client = {
    sse: {
      streamJson: (options) => {
        assert.deepEqual(options.types, [
          "new-utterance",
          "delete-conversation",
        ]);
        return {
          close() {},
          events: (async function* () {
            yield {
              data: {
                utterance: { text: "Selected requirement", speaker: "s" },
                conversation_uuid: "u",
              },
              raw: "unused",
            };
            yield { data: { conversation: { id: 22 } } };
          })(),
        };
      },
    },
    api: {
      conversations: {
        get: async (id) => ({
          id,
          state: "COMPLETED",
          title: "Demo",
          short_summary: "A selected demo requirement",
        }),
      },
    },
  };
  const bee = createBeeSourceClient({
    client,
    selectedConversations: () => [
      { conversationId: "22", conversationUuid: "u" },
    ],
    onCapture: (x) => seen.push(x),
    onDelete: (identity) => deleted.push(identity.conversationId),
  });
  bee.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen[0].text, "Selected requirement");
  assert.equal(seen[0].authorized, false);
  assert.deepEqual(deleted, ["22"]);
  assert.equal((await bee.readConversation("22")).reference, "conversation:22");
  await assert.rejects(
    bee.readConversation("all; login"),
    /InvalidBeeConversationId/,
  );
});
test("changed cursor follows meta.next_cursor and rejects invented cursor keys", () => {
  assert.equal(changedCursor({ meta: { next_cursor: "v1-1" } }), "v1-1");
  assert.throws(
    () => changedCursor({ next_cursor: "wrong" }),
    /InvalidBeeCursor/,
  );
});
import { createJsonSseStream } from "@beeai/cli/lib";
import { PassThrough } from "node:stream";
test("actual upstream SSE wrapper unwraps a raw Bee CLI frame into event.data", async () => {
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const stream = createJsonSseStream(
    {
      spawn: (args) => {
        assert.deepEqual(args, [
          "stream",
          "--json",
          "--types",
          "new-utterance",
        ]);
        queueMicrotask(() => {
          stdout.end(
            JSON.stringify({
              utterance: { text: "hello", speaker: "s" },
              conversation_uuid: "u",
            }) + "\n",
          );
          stderr.end();
        });
        return { stdout, stderr, kill() {}, exited: Promise.resolve(0) };
      },
    },
    { types: ["new-utterance"] },
  );
  const items = [];
  for await (const event of stream.events) items.push(event);
  assert.equal(items[0].data.utterance.text, "hello");
  assert.equal(items[0].data.event, undefined);
});
test("standing proposal scope survives restart, stays narrow and expires; deletion disables it", () => {
  const directory = dir();
  let inbox = createBeeContext({ directory });
  const source = inbox.ingest(beePolicyFixture);
  const scope = inbox.follow(
    source.id,
    "Prepare a tested proposal when this selected requirement changes",
    "fixture",
  );
  assert.equal(scope.authority, "prepare-proposals-only");
  inbox.close();
  inbox = createBeeContext({ directory });
  assert.equal(inbox.scopes().length, 1);
  const update = inbox.ingest({
    ...beePolicyFixture,
    text: "Changed selected context",
  });
  assert.notEqual(inbox.scopes()[0].lastRevision, update.revision);
  inbox.acknowledge({ ...scope, lastRevision: update.revision });
  assert.equal(inbox.scopes()[0].lastRevision, update.revision);
  inbox.remove(source.id);
  assert.equal(inbox.scopes().length, 0);
  inbox.close();
});
macSandboxTest(
  "Bee-derived fixture survives clarification restart then actual failing test, separate patch approval and passing review",
  async () => {
    const directory = dir(),
      inbox = createBeeContext({ directory });
    let cstore = createConversations({
      directory,
      memoryRead: (_, id) => inbox.memory(id),
    });
    const s = inbox.ingest(beePolicyFixture);
    const { conversationId } = inbox.claim(
      s.id,
      s.revision,
      (source, taskId) =>
        cstore.create(
          "owner",
          "Turn the selected Bee requirement into a verified local change.",
          "fixture",
          ["bee:" + source.id],
          "policy",
          { id: s.id, revision: s.revision, simulated: true },
          taskId,
        ).id,
    );
    let c = await cstore.run("owner", conversationId, fixtureCompanion);
    assert.equal(c.status, "clarifying");
    cstore.close();
    cstore = createConversations({
      directory,
      memoryRead: (_, id) => inbox.memory(id),
    });
    c = cstore.get("owner", conversationId);
    assert.equal(c.status, "clarifying");
    c = cstore.send(
      "owner",
      c.id,
      "Confirm: exactly 100 is included, lower totals unchanged.",
      c.version,
    );
    c = await cstore.run("owner", c.id, fixtureCompanion);
    c = cstore.command("owner", c.id, {
      id: "test",
      type: "approve",
      version: c.version,
      digest: c.steps[0].digest,
    });
    c = await cstore.runAction("owner", c.id);
    assert.equal(c.actionEvidence[0].exitCode, 1);
    assert.equal(c.steps[0].stage, "patch");
    assert.equal(c.status, "plan_review");
    c = cstore.command("owner", c.id, {
      id: "patch",
      type: "approve",
      version: c.version,
      digest: c.steps[0].digest,
    });
    c = await cstore.runAction("owner", c.id);
    assert.equal(c.actionEvidence[1].exitCode, 0);
    assert.equal(c.status, "review_required");
    c = cstore.command("owner", c.id, {
      id: "review",
      type: "accept",
      version: c.version,
    });
    assert.equal(c.status, "completed");
    assert.equal(c.approvals.length, 2);
    cstore.close();
    inbox.close();
  },
);
import { spawnSync } from "node:child_process";
test("manual claim retry after task persistence and thrown callback creates exactly one task", () => {
  const directory = dir(),
    inbox = createBeeContext({ directory }),
    store = createConversations({ directory });
  const source = inbox.ingest(beePolicyFixture);
  assert.throws(
    () =>
      inbox.claim(
        source.id,
        source.revision,
        (s, taskId, intent) => {
          store.create(
            "o",
            intent.goal,
            "fixture",
            [],
            "policy",
            { id: s.id, revision: s.revision },
            taskId,
          );
          throw Error("crash window");
        },
        { goal: "Persisted original request" },
      ),
    /crash window/,
  );
  assert.throws(
    () =>
      inbox.claim(
        source.id,
        source.revision,
        () => {
          throw Error("Changed intent must not execute");
        },
        { goal: "Changed retry must not replace reserved intent" },
      ),
    /DifferentIntent/,
  );
  const result = inbox.claim(
    source.id,
    source.revision,
    (s, taskId, intent) =>
      store.create(
        "o",
        intent.goal,
        "fixture",
        [],
        "policy",
        { id: s.id, revision: s.revision },
        taskId,
      ).id,
    { goal: "Persisted original request" },
  );
  assert.equal(result.duplicate, true);
  assert.equal(store.list("o").length, 1);
  assert.equal(
    store.get("o", result.conversationId).messages[0].text,
    "Persisted original request",
  );
  store.close();
  inbox.close();
});
test("SIGKILL between task persistence and claim completion reconciles to one deterministic task", () => {
  const directory = dir(),
    contextModule = new URL("../src/bee-context.mjs", import.meta.url).href,
    conversationModule = new URL("../src/conversations.mjs", import.meta.url)
      .href;
  const program = `import {createBeeContext,beePolicyFixture} from ${JSON.stringify(contextModule)};import {createConversations} from ${JSON.stringify(conversationModule)};const directory=${JSON.stringify(directory)};const inbox=createBeeContext({directory}),store=createConversations({directory});const source=inbox.ingest(beePolicyFixture);inbox.claim(source.id,source.revision,(s,taskId,intent)=>{store.create('o',intent.goal,'fixture',[],'policy',{id:s.id,revision:s.revision},taskId);process.kill(process.pid,'SIGKILL');return taskId},{goal:'Resume this selected requirement'});`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program],
    { timeout: 5000 },
  );
  assert.equal(child.signal, "SIGKILL");
  const inbox = createBeeContext({ directory }),
    store = createConversations({ directory }),
    source = inbox.list()[0];
  const result = inbox.claim(
    source.id,
    source.revision,
    (s, taskId, intent) =>
      store.create(
        "o",
        intent.goal,
        "fixture",
        [],
        "policy",
        { id: s.id, revision: s.revision },
        taskId,
      ).id,
  );
  assert.equal(store.list("o").length, 1);
  assert.equal(
    store.get("o", result.conversationId).messages[0].text,
    "Resume this selected requirement",
  );
  store.close();
  inbox.close();
});
test("stream boundary drops unrelated and expired-scope utterances and maps deletion to selected numeric/UUID identity", async () => {
  const captures = [],
    deletes = [];
  let scopes = [{ conversationId: "22", conversationUuid: "chosen" }];
  const client = {
    sse: {
      streamJson: () => ({
        close() {},
        events: (async function* () {
          yield {
            data: {
              utterance: { text: "UNRELATED PRIVATE TEXT", speaker: "x" },
              conversation_uuid: "other",
            },
          };
          yield {
            data: {
              utterance: { text: "Chosen context", speaker: "s" },
              conversation_uuid: "chosen",
            },
          };
          yield { data: { conversation: { id: 99, uuid: "other" } } };
          yield { data: { conversation: { id: 22 } } };
          scopes = [];
          yield {
            data: {
              utterance: { text: "AFTER SCOPE REVOKED", speaker: "s" },
              conversation_uuid: "chosen",
            },
          };
        })(),
      }),
    },
  };
  const bee = createBeeSourceClient({
    client,
    selectedConversations: () => scopes,
    onCapture: (c) => captures.push(c),
    onDelete: (d) => deletes.push(d),
  });
  bee.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    captures.map((c) => c.text),
    ["Chosen context"],
  );
  assert.equal(captures[0].conversationId, "22");
  assert.deepEqual(deletes, [
    { conversationId: "22", conversationUuid: "chosen" },
  ]);
  assert.throws(() => bee.start(), /SelectAndFollowMappedBeeConversationFirst/);
});
test("deleting a numeric conversation also revokes all mapped streamed sources; audit retention is explicit", () => {
  const directory = dir(),
    revoked = [],
    inbox = createBeeContext({ directory, onRevoke: (id) => revoked.push(id) });
  const a = inbox.ingest({
      reference: "conversation:22",
      conversationId: "22",
      conversationUuid: "chosen",
      text: "Original selected context",
    }),
    b = inbox.ingest({
      reference: "conversation:22:utterance:one",
      conversationId: "22",
      conversationUuid: "chosen",
      text: "Streamed context",
      kind: "utterance",
    });
  inbox.ingest({
    reference: "conversation:99",
    conversationId: "99",
    conversationUuid: "other",
    text: "Other selected conversation",
  });
  inbox.removeConversation("22", "chosen");
  assert.equal(inbox.memory("bee:" + a.id), null);
  assert.equal(inbox.memory("bee:" + b.id), null);
  assert.equal(inbox.list().length, 1);
  assert.equal(revoked.length, 2);
  const result = inbox.remove(inbox.list()[0].id);
  assert.match(result.deletionSemantics, /Historical messages/);
  inbox.close();
});
test("startup reconciles reserved intent without fresh prompt and rejects revoked source reservations", () => {
  const directory = dir();
  let inbox = createBeeContext({ directory }),
    store = createConversations({ directory });
  const source = inbox.ingest(beePolicyFixture);
  assert.throws(
    () =>
      inbox.claim(
        source.id,
        source.revision,
        () => {
          throw Error("crashed before task creation");
        },
        { goal: "Original durable instruction" },
      ),
    /crashed/,
  );
  inbox.close();
  store.close();
  inbox = createBeeContext({ directory });
  store = createConversations({ directory });
  inbox.reconcileClaims(
    (s, taskId, intent) =>
      store.create(
        "o",
        intent.goal,
        "fixture",
        [],
        "policy",
        { id: s.id, revision: s.revision },
        taskId,
      ).id,
  );
  assert.equal(store.list("o").length, 1);
  assert.equal(store.list("o")[0].status, "queued");
  assert.equal(
    store.list("o")[0].messages[0].text,
    "Original durable instruction",
  );
  assert.equal(
    inbox.reconcileClaims(() => {
      throw Error("duplicate create");
    }).length,
    0,
  );
  const other = inbox.ingest({ ...beePolicyFixture, reference: "another" });
  assert.throws(
    () =>
      inbox.claim(
        other.id,
        other.revision,
        () => {
          throw Error("crashed");
        },
        { goal: "Should not revive" },
      ),
    /crashed/,
  );
  inbox.remove(other.id);
  assert.equal(
    inbox.reconcileClaims(() => {
      throw Error("revoked create");
    }).length,
    0,
  );
  store.close();
  inbox.close();
});
test("follow preserves changed owner intent and progress; pause/resume/cancel never silently restore old instructions", () => {
  const directory = dir(),
    inbox = createBeeContext({ directory }),
    source = inbox.ingest(beePolicyFixture);
  inbox.follow(source.id, "Prepare a local update; never publish.", "fixture");
  inbox.updateFollow(source.id, {
    instruction: "Make it a short feature list instead of a long guide.",
    context: [{ id: "draft", items: [{ id: "done", ownerMarkedDone: true }] }],
  });
  let scope = inbox.scopes()[0];
  assert.deepEqual(scope.instructions, [
    "Prepare a local update; never publish.",
    "Make it a short feature list instead of a long guide.",
  ]);
  assert.equal(scope.durableContext[0].items[0].ownerMarkedDone, true);
  inbox.updateFollow(source.id, { pausedReason: "OwnerPaused" });
  assert.equal(inbox.scopes().length, 0);
  assert.equal(inbox.followStates()[0].pausedReason, "OwnerPaused");
  inbox.updateFollow(source.id, { pausedReason: null });
  assert.equal(inbox.scopes()[0].instructions.length, 2);
  inbox.stopFollow(source.id);
  assert.equal(inbox.followStates().length, 0);
  inbox.close();
});
test("automatic proposal budget pauses follow visibly and long intent cannot silently drop an exclusion", () => {
  const directory = dir(),
    inbox = createBeeContext({ directory }),
    source = inbox.ingest(beePolicyFixture);
  let scope = inbox.follow(source.id, "Do not contact anyone.", "fixture");
  assert.equal(scope.maxProposals, 6);
  inbox.acknowledge({
    ...scope,
    proposalsCreated: 6,
    pausedReason: "ProposalBudgetReached",
  });
  assert.equal(inbox.scopes().length, 0);
  assert.equal(inbox.followStates()[0].proposalsCreated, 6);
  inbox.updateFollow(source.id, {
    instruction: "x".repeat(6001),
    pausedReason: null,
  });
  assert.equal(inbox.scopes().length, 0);
  assert.equal(
    inbox.followStates()[0].instructions[0],
    "Do not contact anyone.",
  );
  assert.equal(
    inbox.followStates()[0].pausedReason,
    "IntentContextBudgetReached",
  );
  inbox.close();
});
test("ordinary resume cannot bypass proposal budget; explicit renewal retains all owner exclusions and progress", () => {
  const directory = dir(),
    inbox = createBeeContext({ directory }),
    source = inbox.ingest(beePolicyFixture);
  let scope = inbox.follow(source.id, "Local only; do not publish.", "fixture");
  inbox.updateFollow(source.id, {
    instruction: "Use a short feature list.",
    context: [{ done: true }],
  });
  scope = inbox.scopes()[0];
  inbox.acknowledge({
    ...scope,
    proposalsCreated: 6,
    pausedReason: "ProposalBudgetReached",
  });
  inbox.updateFollow(source.id, { pausedReason: null });
  assert.equal(inbox.scopes().length, 0);
  inbox.follow(source.id, "Continue reviewing changed context.", "fixture");
  scope = inbox.scopes()[0];
  assert.equal(scope.proposalsCreated, 0);
  assert.equal(scope.instructions[0], "Local only; do not publish.");
  assert.equal(scope.instructions[1], "Use a short feature list.");
  assert.deepEqual(scope.durableContext, [{ done: true }]);
  inbox.close();
});
import { conversationText } from "../src/bee-client.mjs";
test("chosen conversation context uses documented summary/transcription fields and excludes incidental location/profile data", () => {
  const text = conversationText({
    id: 22,
    uuid: "chosen",
    title: "Policy demo",
    short_summary: "A requested discount",
    transcriptions: [
      { utterances: [{ text: "Totals below 100 stay unchanged." }] },
    ],
    location: { latitude: 1, longitude: 2 },
    profile: { email: "private@example.invalid" },
  });
  assert.match(text, /Totals below 100/);
  assert.match(text, /recognition errors/);
  assert.doesNotMatch(text, /latitude|longitude|private@example/);
  assert.throws(
    () => conversationText({ title: "Still processing" }),
    /BeeConversationNotProcessed/,
  );
});
test("UUID-only unrelated deletion cannot match an unmapped selected source", async () => {
  const deleted = [];
  const bee = createBeeSourceClient({
    selectedConversations: () => [
      { conversationId: null, conversationUuid: null },
      { conversationId: "22", conversationUuid: "chosen" },
    ],
    client: {
      sse: {
        streamJson: () => ({
          close() {},
          events: (async function* () {
            yield { data: { conversation: { uuid: "unrelated" } } };
          })(),
        }),
      },
    },
    onDelete: (d) => deleted.push(d),
  });
  bee.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(deleted, []);
});
test("stream process closes when selected scope expires instead of continuing unrelated observation", async () => {
  let scopes = [{ conversationId: "22", conversationUuid: "chosen" }],
    closed = 0;
  const bee = createBeeSourceClient({
    selectedConversations: () => scopes,
    client: {
      sse: {
        streamJson: () => ({
          close() {
            closed++;
          },
          events: (async function* () {
            yield {
              data: {
                utterance: { text: "Chosen", speaker: "s" },
                conversation_uuid: "chosen",
              },
            };
            scopes = [];
            yield {
              data: {
                utterance: { text: "Unrelated after expiry", speaker: "s" },
                conversation_uuid: "other",
              },
            };
          })(),
        }),
      },
    },
  });
  bee.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, 1);
  assert.equal(bee.status().started, false);
});

import { createBeeInboxBridge } from "../src/bee-inbox-bridge.mjs";
test("a followed stream refreshes one numeric parent source rather than creating utterance sources", async () => {
  const inbox = createBeeContext({ directory: dir() });
  let text = "Original transcript";
  let bridge;
  const client = {
    api: {
      conversations: {
        get: async () => ({
          id: 42,
          state: "COMPLETED",
          uuid: "chosen",
          transcriptions: [{ utterances: [{ text }] }],
        }),
      },
    },
    sse: {
      streamJson: () => ({
        close() {},
        events: (async function* () {
          yield {
            data: {
              conversation_uuid: "chosen",
              utterance: { text: "new words", speaker: "speaker_1" },
            },
          };
        })(),
      }),
    },
  };
  const bee = createBeeSourceClient({
    client,
    selectedConversations: () => [
      { conversationId: "42", conversationUuid: "chosen" },
    ],
    onCapture: (c) => bridge.capture(c),
  });
  bridge = createBeeInboxBridge({ bee, inbox });
  const prior = inbox.ingest(await bee.readConversation("42"));
  text = "Changed transcript";
  bee.start();
  await new Promise((r) => setTimeout(r, 15));
  const rows = inbox.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reference, "conversation:42");
  assert.equal(rows[0].revision, prior.revision + 1);
  bee.stop();
  inbox.close();
});

test("large real conversation keeps recent utterances in a bounded transcript with explicit trimming", () => {
  const utterances = Array.from({ length: 40 }, (_, i) => ({
    text: `Utterance ${i}: ` + "plant care ".repeat(75),
  }));
  const text = conversationText({
    title: "Workshop",
    short_summary: "Plan it",
    transcriptions: [{ utterances }],
  });
  assert.ok(Buffer.byteLength(text) <= 12000);
  assert.match(text, /Earlier transcript trimmed: \d+ utterances/);
  assert.match(text, /Utterance 39:/);
  assert.doesNotMatch(text, /Utterance 0:/);
});

test("late summary preserves task and exact consented context while transcript edits revoke it", async () => {
  const directory = dir();
  let store;
  const inbox = createBeeContext({
    directory,
    onRevoke: (id) => store?.revokeMemory("o", id),
  });
  store = createConversations({
    directory,
    memoryRead: (_, id) => inbox.memory(id),
  });
  let record = {
    id: 5,
    state: "COMPLETED",
    title: "Plants",
    short_summary: "Old summary",
    transcriptions: [
      { utterances: [{ text: "Prepare workshop; never send invitations." }] },
    ],
  };
  const bee = createBeeSourceClient({
    client: { api: { conversations: { get: async () => record } } },
  });
  const source = inbox.ingest(await bee.readConversation(5));
  const claim = inbox.claim(
    source.id,
    source.revision,
    (s, id) =>
      store.create(
        "o",
        "Prepare",
        "fixture",
        ["bee:" + s.id],
        "workshop",
        { id: s.id },
        id,
      ).id,
    { contextDigest: source.contextDigest },
  );
  const before = store.get("o", claim.conversationId);
  record = { ...record, short_summary: "New summary with unapproved details" };
  const fresh = inbox.ingest(await bee.readConversation(5));
  assert.equal(fresh.revision, source.revision);
  assert.equal(store.get("o", before.id).status, "queued");
  assert.match(inbox.memory("bee:" + source.id).text, /Old summary/);
  assert.doesNotMatch(
    inbox.memory("bee:" + source.id).text,
    /unapproved details/,
  );
  assert.notEqual(fresh.contextDigest, source.contextDigest);
  assert.throws(
    () =>
      inbox.claim(fresh.id, fresh.revision, () => {}, {
        contextDigest: source.contextDigest,
      }),
    /SourceContextChanged/,
  );
  record = {
    ...record,
    transcriptions: [{ utterances: [{ text: "Changed transcript" }] }],
  };
  inbox.ingest(await bee.readConversation(5));
  assert.equal(store.get("o", before.id).status, "source_changed");
  store.close();
  inbox.close();
});
test("uncompleted Bee records refuse selection even with a temporary transcript", async () => {
  const bee = createBeeSourceClient({
    client: {
      api: {
        conversations: {
          get: async () => ({
            id: 9,
            state: "CAPTURING",
            transcriptions: [{ utterances: [{ text: "Temporary speech" }] }],
          }),
        },
      },
    },
  });
  await assert.rejects(
    bee.readConversation(9),
    /Bee is still processing this conversation/,
  );
});

import { discoverBeeConversations } from "../src/bee-discovery.mjs";
test("opt-in discovery adds unseen processed sources without tasks or inference and retries processing entries", async () => {
  const directory = dir(),
    inbox = createBeeContext({ directory }),
    store = createConversations({ directory });
  inbox.ingest({
    reference: "conversation:1",
    conversationId: "1",
    text: "Already present",
  });
  let calls = 0;
  const bee = {
    listRecentConversations: async () => [
      { id: "1" },
      { id: "2" },
      { id: "3" },
    ],
    readConversation: async (id) => {
      calls++;
      return {
        reference: "conversation:" + id,
        conversationId: id,
        text: "Processed " + id,
      };
    },
  };
  const result = await discoverBeeConversations({ bee, inbox });
  assert.equal(result.added, 2);
  assert.equal(calls, 2);
  assert.equal(inbox.list().length, 3);
  assert.equal(store.list("o").length, 0);
  assert.equal(inbox.list().filter((s) => s.discovered).length, 2);
  await discoverBeeConversations({ bee, inbox });
  assert.equal(calls, 2);
  store.close();
  inbox.close();
});

test("ready source selection with a changed goal cannot silently discard the new instruction", () => {
  const inbox = createBeeContext({ directory: dir() });
  const source = inbox.ingest(beePolicyFixture);
  let made = 0;
  const make = (_, id) => {
    made++;
    return id;
  };
  const first = inbox.claim(source.id, source.revision, make, {
    goal: "Original goal",
  });
  assert.throws(
    () =>
      inbox.claim(source.id, source.revision, make, { goal: "Different goal" }),
    (e) =>
      e.message === "SourceAlreadyClaimedWithDifferentIntent" &&
      e.existingConversationId === first.conversationId,
  );
  assert.equal(made, 1);
  assert.equal(
    inbox.claim(source.id, source.revision, make, { goal: "Original goal" })
      .conversationId,
    first.conversationId,
  );
  inbox.close();
});

test("R2 summary arrival before first consent freezes exactly the visible snapshot only at selection", async () => {
  const inbox = createBeeContext({ directory: dir() });
  let record = {
    id: 77,
    state: "COMPLETED",
    title: "Synthetic",
    transcriptions: [
      { utterances: [{ text: "Original synthetic transcript" }] },
    ],
  };
  const bee = createBeeSourceClient({
    client: { api: { conversations: { get: async () => record } } },
  });
  const before = inbox.ingest(await bee.readConversation(77));
  record = {
    ...record,
    short_summary: "New visible summary before any selection",
  };
  const shown = inbox.ingest(await bee.readConversation(77));
  assert.equal(shown.revision, before.revision);
  assert.equal(shown.approvedText, undefined);
  inbox.claim(
    shown.id,
    shown.revision,
    (source, id) => {
      assert.equal(inbox.memory("bee:" + source.id).text, shown.text);
      return id;
    },
    { goal: "First consent", contextDigest: shown.contextDigest },
  );
  const approved = inbox.memory("bee:" + shown.id).text;
  assert.match(approved, /New visible summary/);
  record = { ...record, short_summary: "Unapproved later summary" };
  inbox.ingest(await bee.readConversation(77));
  assert.equal(inbox.memory("bee:" + shown.id).text, approved);
  inbox.close();
});

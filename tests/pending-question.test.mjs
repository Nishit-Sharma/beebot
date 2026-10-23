import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversations } from "../src/conversations.mjs";
import { hash } from "../src/demo-runner.mjs";

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "bee-question-"));
  let now = 10;
  const sources = new Map();
  const memories = new Map([
    [
      "original",
      { text: "No invitations, purchases or bookings", revision: 1 },
    ],
  ]);
  const options = {
    directory,
    clock: () => now,
    memoryRead: (_, id) => memories.get(id),
    replySourceRead: (_, id) => sources.get(id),
  };
  let store = createConversations(options);
  let task = store.create(
    "owner",
    "Prepare a 45-minute beginner workshop. Do not send invitations.",
    "codex",
    ["original"],
  );
  task = await store.run("owner", task.id, async () => ({
    reply: "One question",
    questions: ["Did you mean an imaginary plant?"],
    steps: [],
  }));
  const text =
    task.pendingQuestion.token +
    ". Yes, an imaginary plant. Keep the original exclusions.";
  const source = {
    id: "reply",
    revision: 1,
    reference: "conversation:52",
    kind: "conversation",
    contextDigest: hash(text),
    text,
    simulated: false,
    deleted: false,
  };
  sources.set(source.id, source);
  memories.set("bee:" + source.id, { text, revision: 1 });
  const input = {
    id: "selected-reply",
    type: "answer-question",
    version: task.version,
    questionId: task.pendingQuestion.id,
    replyToken: task.pendingQuestion.token,
    sourceId: source.id,
    sourceRevision: source.revision,
    contextDigest: source.contextDigest,
    confirmed: true,
    providerConsent: "codex-openai",
  };
  return {
    directory,
    options,
    sources,
    memories,
    source,
    input,
    task,
    get store() {
      return store;
    },
    advance() {
      now += 3600001;
    },
    reopen() {
      store.close();
      store = createConversations(options);
    },
  };
}

test("explicit selected reply survives restart, resumes the same task, retains original constraints and deduplicates", async () => {
  const x = await setup();
  x.reopen();
  const task = x.store.command("owner", x.task.id, x.input);
  assert.equal(task.id, x.task.id);
  assert.equal(task.status, "queued");
  assert.equal(task.pendingQuestion.state, "answered");
  assert.equal(x.store.list("owner").length, 1);
  x.store.command("owner", x.task.id, x.input);
  assert.equal(
    x.store.get("owner", task.id).messages.filter((m) => m.beeReply).length,
    1,
  );
  let calls = 0;
  const result = await x.store.run(
    "owner",
    task.id,
    async ({ messages, memory }) => {
      calls++;
      assert.match(messages[0].text, /45-minute.*Do not send invitations/);
      assert.match(
        messages.at(-1).text,
        /imaginary plant.*original exclusions/,
      );
      assert.ok(
        memory.some((m) =>
          /No invitations, purchases or bookings/.test(m.text),
        ),
      );
      return {
        reply: "Prepared",
        questions: [],
        steps: [
          {
            id: "draft",
            title: "Workshop",
            capability: "local.document",
            content:
              "45-minute beginner workshop with imaginary plant. No invitations, purchases or bookings.",
            dependsOn: [],
          },
        ],
      };
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "review_required");
  assert.equal(result.pendingQuestion, null);
  assert.equal(result.questionHistory.at(-1).state, "answered");
  x.store.close();
});

test("tokens alone never authorize a reply and invalid selections create no queued turn", async () => {
  for (const [change, expected] of [
    [{ confirmed: false }, /ConsentRequired/],
    [{ providerConsent: null }, /ConsentRequired/],
    [{ replyToken: "BEE-000000" }, /Mismatch/],
    [{ questionId: "another-question" }, /Mismatch/],
    [{ sourceRevision: 2 }, /SourceChanged/],
    [{ contextDigest: "changed" }, /SourceChanged/],
    [{ sourceId: "missing" }, /SourceChanged/],
    [{ version: 999 }, /StaleRevision/],
  ]) {
    const x = await setup();
    assert.throws(
      () => x.store.command("owner", x.task.id, { ...x.input, ...change }),
      expected,
    );
    assert.equal(x.store.get("owner", x.task.id).status, "clarifying");
    assert.equal(
      x.store.get("owner", x.task.id).messages.filter((m) => m.beeReply).length,
      0,
    );
    x.store.close();
  }
});

test("expired, ambiguous, deleted, revoked and changed-source answers cannot resume work", async () => {
  for (const kind of [
    "expired",
    "ambiguous",
    "deleted",
    "revoked",
    "changed",
    "paused",
    "manual-correction",
  ]) {
    const x = await setup();
    if (kind === "expired") x.advance();
    if (kind === "ambiguous") x.source.text += " BEE-000000";
    if (kind === "deleted") x.source.deleted = true;
    if (kind === "revoked") {
      x.memories.delete("original");
      x.store.revokeMemory("owner", "original");
    }
    if (kind === "changed")
      x.memories.set("bee:reply", {
        text: "Changed selected answer",
        revision: 2,
      });
    if (kind === "paused")
      x.store.command("owner", x.task.id, {
        id: "pause",
        type: "pause",
        version: x.task.version,
      });
    if (kind === "manual-correction")
      x.store.send(
        "owner",
        x.task.id,
        "Use another task instead",
        x.task.version,
      );
    const current = x.store.get("owner", x.task.id);
    assert.throws(
      () =>
        x.store.command("owner", x.task.id, {
          ...x.input,
          version: current.version,
        }),
      /Expired|AmbiguousToken|SourceChanged|Unavailable/,
    );
    assert.equal(
      x.store.get("owner", x.task.id).messages.filter((m) => m.beeReply).length,
      0,
    );
    x.store.close();
  }
});

test("an answer source edited after selection revokes the queued continuation before any provider call", async () => {
  const x = await setup();
  const task = x.store.command("owner", x.task.id, x.input);
  x.memories.set("bee:reply", { text: "Edited reply", revision: 2 });
  let calls = 0;
  const result = await x.store.run("owner", task.id, async () => {
    calls++;
    throw Error("must not run");
  });
  assert.equal(result.status, "source_changed");
  assert.equal(calls, 0);
  x.store.close();
});

test("the default application transport remains disabled and no discovery path can submit an answer", async () => {
  const x = await setup();
  x.store.close();
  const { replySourceRead, ...disabled } = x.options;
  const store = createConversations(disabled);
  assert.throws(
    () => store.command("owner", x.task.id, x.input),
    /TransportUnavailable/,
  );
  assert.equal(store.get("owner", x.task.id).status, "clarifying");
  store.close();
});

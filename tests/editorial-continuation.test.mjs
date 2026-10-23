import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConversations } from "../src/conversations.mjs";
import { editorialContinuation } from "../src/editorial-continuation.mjs";
const question =
  "Should Q&A remain at the end shortened from six minutes, or should I redistribute that time?";
const input = {
  messages: [
    {
      role: "user",
      text: "Prepare a workshop with questions at the end. No invitations.",
    },
    {
      role: "user",
      text: "Make it 30 minutes. Keep beginner audience, imaginary plant activity, all original exclusions.",
    },
  ],
  memory: [],
  artifacts: [],
};
const ask = (questions) => ({
  reply: "One material detail remains unclear",
  questions,
  steps: [],
});

test("30-minute correction retains end Q&A without another owner turn and records one bounded private retry", async () => {
  const store = createConversations({
    directory: mkdtempSync(join(tmpdir(), "bee-editorial-")),
  });
  let c = store.create("owner", input.messages[0].text, "fixture");
  c = store.send("owner", c.id, input.messages[1].text, c.version);
  let calls = 0;
  c = await store.run("owner", c.id, async (request) => {
    calls++;
    if (calls === 1) return ask([question]);
    assert.match(
      request.privatePreparationReview.instruction,
      /questions at the end/,
    );
    assert.equal(request.messages.filter((m) => m.role === "user").length, 2);
    assert.equal(request.messages[0].text, input.messages[0].text);
    return {
      reply: "I kept questions at the end and shortened the sections.",
      questions: [],
      steps: [
        {
          id: "agenda",
          title: "30-minute workshop",
          capability: "local.document",
          content:
            "0-5 welcome,5-12 light,12-20 watering,20-25 imaginary plant activity,25-30 questions. Beginner audience. No invitations.",
          dependsOn: [],
        },
      ],
    };
  });
  assert.equal(calls, 2);
  assert.equal(c.status, "review_required");
  assert.equal(c.artifacts.length, 1);
  assert.equal(c.messages.filter((m) => m.role === "user").length, 2);
  assert.equal(c.messages.at(-1).questions.length, 0);
  assert.equal(c.guidanceRequests.length, 2);
  assert.notEqual(
    c.guidanceRequests[0].requestDigest,
    c.guidanceRequests[1].requestDigest,
  );
  assert.ok(c.events.some((e) => e.type === "editorial-continuation"));
  store.close();
});

test("editorial review generalizes to report compression and beginner wording, not permission or material uncertainty", () => {
  for (const text of [
    "Should I keep recommendations when shortening the report?",
    "Would you prefer simpler wording for beginners?",
  ])
    assert.ok(
      editorialContinuation(ask([text]), {
        ...input,
        messages: [
          {
            role: "user",
            text: "Shorten this report and keep its recommendations.",
          },
        ],
      }),
    );
  for (const text of [
    "Is it Alex or Alice?",
    "Is the budget fifteen or fifty dollars?",
    "Which Friday is the deadline?",
    "Should I send the shortened report to everyone?",
    "Should I book a room for this workshop?",
    "Should I shorten the workshop to 13 or 30 minutes?",
    "Should I simplify the activity for ages six or sixteen?",
    "Should the wording say June 12 or June 21?",
    "Should I shorten the workshop to thirteen or thirty minutes?",
    "Should the wording refer to Morgan or Jordan?",
  ])
    assert.equal(editorialContinuation(ask([text]), input), null);
  assert.equal(
    editorialContinuation(ask([question]), {
      ...input,
      messages: [
        {
          role: "user",
          text: "Prepare a plan but ask me first and do not assume.",
        },
      ],
    }),
    null,
  );
});

test("repeated editorial questions fail visibly after two attempts without fabricating a draft", async () => {
  const store = createConversations({
    directory: mkdtempSync(join(tmpdir(), "bee-editorial-bound-")),
  });
  let c = store.create(
      "owner",
      "Shorten the report; retain recommendations.",
      "fixture",
    ),
    calls = 0;
  c = await store.run("owner", c.id, async () => {
    calls++;
    return ask(["Should I keep recommendations when shortening the report?"]);
  });
  assert.equal(calls, 2);
  assert.equal(c.status, "failed");
  assert.match(c.error, /PrivateDraftNotProduced/);
  assert.equal(c.artifacts.length, 0);
  assert.equal(c.pendingQuestion, undefined);
  store.close();
});

test("unresolved duration alternatives stay visible instead of consuming the editorial retry", async () => {
  const store = createConversations({ directory: mkdtempSync(join(tmpdir(), "bee-material-duration-")) });
  let c = store.create("owner", "Shorten the workshop plan for beginners", "fixture"), calls = 0;
  c = await store.run("owner", c.id, async () => {
    calls++;
    return ask(["Should I shorten the workshop to 13 or 30 minutes?"]);
  });
  assert.equal(calls, 1);
  assert.equal(c.status, "clarifying");
  assert.equal(c.messages.at(-1).questions[0], "Should I shorten the workshop to 13 or 30 minutes?");
  assert.ok(c.pendingQuestion);
  assert.equal(c.error, undefined);
  store.close();
});

test("source revocation between editorial attempts prevents a second provider call", async () => {
  let memory = { text: "No invitations", revision: 1 },
    calls = 0;
  const store = createConversations({
    directory: mkdtempSync(join(tmpdir(), "bee-editorial-source-")),
    memoryRead: () => memory,
  });
  let c = store.create(
    "owner",
    "Make the workshop 30 minutes; retain end Q&A.",
    "fixture",
    ["memory"],
  );
  c = await store.run("owner", c.id, async () => {
    calls++;
    memory = null;
    return ask([question]);
  });
  assert.equal(calls, 1);
  assert.equal(c.status, "source_changed");
  store.close();
});

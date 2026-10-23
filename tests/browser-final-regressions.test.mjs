import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createHarness } from "../src/harness.mjs";
import { createConversations } from "../src/conversations.mjs";
import { fixtureCompanion } from "../src/fixture-companion.mjs";
import * as visuals from "../public/visuals.mjs";
const temp = () => mkdtempSync(join(tmpdir(), "bee-browser-regression-"));

test("accepted memory saves current receipt artifacts, preserves corrections and accurately binds original artifact revisions", async () => {
  const directory = temp(),
    store = createConversations({ directory }),
    h = createHarness({ directory });
  try {
    let c = store.create(
      "owner",
      "Plan a workshop; do not send invitations.",
      "fixture",
    );
    const proposal = (minutes) => ({
      reply: "Private plan.",
      questions: [],
      steps: [
        {
          id: "plan",
          title: "Workshop",
          capability: "local.document",
          content: `CURRENT_OUTPUT_${minutes}_MINUTES`,
          dependsOn: [],
        },
      ],
    });
    c = await store.run("owner", c.id, async () => proposal(45));
    const old = c.artifacts[0];
    c = store.send(
      "owner",
      c.id,
      "Correct to 30 minutes, beginners; keep the no-send constraint.",
      c.version,
    );
    c = await store.run("owner", c.id, async () => proposal(30));
    c = store.command("owner", c.id, {
      id: "accept",
      type: "accept",
      version: c.version,
    });
    const current = c.artifacts[1];
    const memory = await Effect.runPromise(
      h.memory("owner", "save-conversation", { conversation: c }),
    );
    assert.match(memory.text, /CURRENT_OUTPUT_30_MINUTES/);
    assert.doesNotMatch(memory.text, /CURRENT_OUTPUT_45_MINUTES/);
    assert.match(memory.text, /Correct to 30 minutes, beginners/);
    assert.match(memory.text, /do not send invitations/);
    assert.deepEqual(
      memory.sourceProvenance.artifacts.map((a) => a.id),
      [current.id],
    );
    assert.equal(
      memory.sourceProvenance.artifacts[0].revision,
      current.plan.revision,
    );
    assert.equal(memory.sourceProvenance.acceptedVersion, c.version);
    assert.equal(memory.sourceProvenance.instructions.length, 2);
    assert.equal(store.get("owner", c.id).artifacts[0].id, old.id);
    assert.equal(store.get("owner", c.id).artifacts.length, 2);
  } finally {
    h.close();
    store.close();
  }
});

test("composer drafts stay scoped across task switches, New task, samples and tab reload", () => {
  const data = new Map(),
    storage = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v),
    };
  let text = "";
  const options = {
    storage,
    read: () => text,
    write: (v) => {
      text = v;
    },
  };
  let drafts = visuals.createComposerDrafts(options);
  drafts.select("workshop");
  text = "Unsent workshop correction";
  drafts.save();
  drafts.select(null);
  assert.equal(text, "");
  text = "New task idea";
  drafts.save();
  drafts.select("discount");
  assert.equal(text, "");
  text = "Discount-specific draft";
  drafts.save();
  drafts.select("workshop");
  assert.equal(text, "Unsent workshop correction");
  text = "";
  drafts = visuals.createComposerDrafts(options);
  assert.equal(drafts.currentId(), "workshop");
  drafts.select("workshop");
  assert.equal(text, "Unsent workshop correction");
  drafts.select("discount");
  assert.equal(text, "Discount-specific draft");
  drafts.select(null);
  assert.equal(text, "New task idea");
  drafts.clear();
  assert.equal(text, "");
  drafts.select("workshop");
  assert.equal(text, "Unsent workshop correction");
  drafts.select(null);
  assert.equal(text, "");
});

test("fresh retries clear only active errors; still-failing retries report a new failure and successful actions retain historical failures", async () => {
  let failures = 2;
  const store = createConversations({
    directory: temp(),
    runSandbox: async () => {
      if (failures-- > 0)
        throw Error(
          failures === 1 ? "SandboxUnavailable" : "SecondSyntheticFailure",
        );
      return {
        exitCode: 0,
        output: "Synthetic runner: passed",
        sourceHash: "synthetic-source",
        outputHash: "synthetic-output",
      };
    },
  });
  try {
    let c = store.create(
      "owner",
      "Discount threshold",
      "fixture",
      [],
      "policy",
    );
    c = await store.run("owner", c.id, fixtureCompanion);
    c = store.send(
      "owner",
      c.id,
      "Confirmed threshold 100 inclusive",
      c.version,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      c = await store.run("owner", c.id, fixtureCompanion);
      c = store.command("owner", c.id, {
        id: "approve-" + attempt,
        type: "approve",
        version: c.version,
        digest: c.steps[0].digest,
      });
      c = await store.runAction("owner", c.id);
      if (attempt < 2) {
        assert.equal(c.status, "failed");
        assert.ok(c.error);
        if (attempt === 1) assert.match(c.error, /SecondSyntheticFailure/);
        c = store.send(
          "owner",
          c.id,
          "Please retry the same confirmed condition.",
          c.version,
        );
        assert.equal(c.error, undefined);
      }
    }
    assert.equal(c.status, "review_required");
    assert.equal(c.error, undefined);
    assert.equal(c.events.filter((e) => e.type === "failure").length, 2);
  } finally {
    store.close();
  }
});

test("draft acknowledgments cannot clear another task or text typed after submission", () => {
  let text = "";
  const drafts = visuals.createComposerDrafts({
    read: () => text,
    write: (value) => {
      text = value;
    },
  });
  drafts.select("first");
  text = "Submitted";
  drafts.save();
  drafts.select("second");
  text = "Keep second draft";
  drafts.acknowledge("first", "Submitted");
  assert.equal(text, "Keep second draft");
  drafts.select("first");
  assert.equal(text, "");
  text = "Later typing";
  drafts.acknowledge("first", "Submitted");
  assert.equal(text, "Later typing");
});

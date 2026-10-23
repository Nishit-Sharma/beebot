import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversations } from "../src/conversations.mjs";
import { taskCoverage } from "../src/task-coverage.mjs";
import { hash } from "../src/demo-runner.mjs";
const store = () =>
  createConversations({
    directory: mkdtempSync(join(tmpdir(), "bee-coverage-")),
  });
test("clarification retains original objective and no-send constraint in the conservative ledger", () => {
  const s = store();
  let c = s.create(
    "owner",
    "Plan a workshop; don't send invitations.",
    "fixture",
  );
  c = s.send("owner", c.id, "45 minutes for beginners", c.version);
  const rows = taskCoverage([c]);
  assert.equal(rows[0].state, "retained-context");
  assert.equal(rows[1].objective, "Plan a workshop; don't send invitations.");
  assert.deepEqual(rows[1].activeContext, [
    "Plan a workshop; don't send invitations.",
    "45 minutes for beginners",
  ]);
  assert.equal(c.messages[0].text, "Plan a workshop; don't send invitations.");
  s.close();
});
test("additive request and progress report do not supersede prior requirements", () => {
  const s = store();
  let c = s.create(
    "owner",
    "Prepare a release note; hold publication.",
    "fixture",
  );
  c = s.send("owner", c.id, "Also include accessibility changes.", c.version);
  c = s.send(
    "owner",
    c.id,
    "The first draft is reviewed; shorten the remaining explanation.",
    c.version,
  );
  const rows = taskCoverage([c]);
  assert.deepEqual(
    rows.slice(0, 2).map((r) => r.state),
    ["retained-context", "retained-context"],
  );
  assert.equal(rows.at(-1).activeContext.length, 3);
  assert.match(rows.at(-1).activeContext[0], /hold publication/);
  s.close();
});
test("replacement wording or a model assertion alone is not stored owner replacement evidence", () => {
  const s = store();
  let c = s.create("owner", "Create a long guide.", "fixture");
  c = s.send(
    "owner",
    c.id,
    "Replace the guide with a short feature list.",
    c.version,
  );
  c.messages.push({
    role: "assistant",
    text: "The original request is superseded.",
  });
  assert.equal(taskCoverage([c])[0].state, "retained-context");
  c.intentChanges = [
    {
      type: "replace-request",
      source: "model",
      scope: "entire-message",
      actor: "owner",
      requestNumber: 1,
      replacementRequestNumber: 2,
      requestDigest: hash(c.messages[0].text),
    },
  ];
  assert.equal(taskCoverage([c])[0].state, "retained-context");
  s.close();
});
test("exact owner-recorded replacement supersedes only its target and retains a separate original constraint", () => {
  const s = store();
  let c = s.create(
    "owner",
    "Keep everything local and do not publish.",
    "fixture",
  );
  c = s.send("owner", c.id, "Prepare a long illustrated guide.", c.version);
  c = s.send(
    "owner",
    c.id,
    "Replace the long guide with a short feature list.",
    c.version,
  );
  const digest = hash("Prepare a long illustrated guide.");
  assert.throws(
    () =>
      s.command("other", c.id, {
        id: "steal",
        version: c.version,
        type: "replace-request",
        requestNumber: 2,
        replacementRequestNumber: 3,
        requestDigest: digest,
      }),
    /Unauthorized/,
  );
  c = s.command("owner", c.id, {
    id: "replace",
    version: c.version,
    type: "replace-request",
    requestNumber: 2,
    replacementRequestNumber: 3,
    requestDigest: digest,
  });
  const rows = taskCoverage([c]);
  assert.equal(rows[0].state, "retained-context");
  assert.equal(rows[1].state, "superseded");
  assert.match(rows[1].note, /request 3/);
  assert.deepEqual(rows[2].activeContext, [
    "Keep everything local and do not publish.",
    "Replace the long guide with a short feature list.",
  ]);
  s.close();
});
test("cancellation is explicit task state and never turns retained constraints into implied new authorization", () => {
  const s = store();
  let c = s.create(
    "owner",
    "Diagnose resource usage; do not change settings.",
    "fixture",
  );
  c = s.send("owner", c.id, "Start with a read-only report.", c.version);
  c = s.command("owner", c.id, {
    id: "cancel",
    type: "cancel",
    version: c.version,
  });
  const rows = taskCoverage([c]);
  assert.equal(rows[0].state, "retained-context");
  assert.equal(rows[1].state, "canceled");
  assert.match(rows[1].activeContext[0], /do not change settings/);
  assert.equal(c.steps.length, 0);
  s.close();
});

test("source outages report waiting rather than active progress for inference and approved actions", () => {
  const s = store();
  const c = s.create(
    "owner",
    "Prepare a local plan; do not send it.",
    "fixture",
  );
  for (const status of ["waiting_source", "waiting_source_action"]) {
    const row = taskCoverage([{ ...c, status }])[0];
    assert.equal(row.state, "waiting-for-source");
    assert.match(row.note, /fresh selected Bee source/);
    assert.match(row.note, /no active progress/);
    assert.match(row.activeContext[0], /do not send/);
  }
  s.close();
});

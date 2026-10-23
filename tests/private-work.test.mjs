import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyPrivateWork, progressContext } from "../src/private-work.mjs";
import { hash } from "../src/demo-runner.mjs";
import { createConversations } from "../src/conversations.mjs";
import { taskCoverage } from "../src/task-coverage.mjs";
const schedule = {
  window: { start: "09:00", end: "12:00" },
  blocks: [
    {
      id: "draft",
      title: "Draft a short update",
      start: "09:00",
      end: "09:30",
    },
    {
      id: "review",
      title: "Review supplied policy",
      start: "09:30",
      end: "10:15",
    },
  ],
  unscheduled: ["Site visit waits for hardware tomorrow"],
};
test("private time plan checks positive durations, contained window, overlap and explicit unscheduled work", () => {
  const v = verifyPrivateWork("local.schedule", JSON.stringify(schedule));
  assert.deepEqual(
    v.data.blocks.map((b) => b.minutes),
    [30, 45],
  );
  assert.match(v.checks[2], /75 minutes/);
  assert.throws(
    () =>
      verifyPrivateWork(
        "local.schedule",
        JSON.stringify({
          ...schedule,
          blocks: [
            schedule.blocks[0],
            { ...schedule.blocks[1], start: "09:20" },
          ],
        }),
      ),
    /OverlappingTimeBlocks/,
  );
  assert.throws(
    () =>
      verifyPrivateWork(
        "local.schedule",
        JSON.stringify({
          ...schedule,
          blocks: [{ ...schedule.blocks[0], end: "13:00" }],
        }),
      ),
    /TimeBlockOutsideWindow/,
  );
  assert.throws(
    () =>
      verifyPrivateWork(
        "local.schedule",
        JSON.stringify({
          ...schedule,
          window: { start: "25:00", end: "26:00" },
        }),
      ),
    /InvalidPlanTime/,
  );
});
test("checklist never claims autonomous completion and rejects duplicate identities", () => {
  assert.throws(
    () =>
      verifyPrivateWork(
        "local.checklist",
        JSON.stringify({
          items: [{ id: "send", text: "Send update", done: true }],
        }),
      ),
    /InvalidChecklistItem/,
  );
  assert.throws(
    () =>
      verifyPrivateWork(
        "local.checklist",
        JSON.stringify({
          items: [
            { id: "one", text: "A" },
            { id: "one", text: "B" },
          ],
        }),
      ),
    /InvalidChecklistItem/,
  );
});
test("noncoding private artifacts prepare without approval; owner progress survives restart and is supplied on correction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bee-private-"));
  let store = createConversations({ directory });
  let c = store.create(
    "owner",
    "Plan 09:00–12:00 using only supplied tasks; hold all publication.",
    "fixture",
  );
  c = await store.run("owner", c.id, async () => ({
    reply: "A local plan and checklist are ready. Nothing published.",
    questions: [],
    steps: [
      {
        id: "time",
        title: "Morning time plan",
        capability: "local.schedule",
        content: JSON.stringify(schedule),
        dependsOn: [],
      },
      {
        id: "list",
        title: "Follow-through checklist",
        capability: "local.checklist",
        content: JSON.stringify({
          items: [
            { id: "draft", text: "Draft concise feature list" },
            {
              id: "policy",
              text: "Review supplied policy; preserve excluded approval workflow",
            },
          ],
        }),
        dependsOn: ["time"],
      },
    ],
  }));
  assert.equal(c.status, "review_required");
  assert.equal(c.approvals.length, 0);
  assert.equal(c.artifacts.length, 2);
  const artifact = c.artifacts[1];
  const command = {
    id: "done",
    type: "checklist-item",
    artifactId: artifact.id,
    itemId: "draft",
    done: true,
    version: c.version,
  };
  c = store.command("owner", c.id, command);
  assert.deepEqual(store.command("owner", c.id, command), c);
  assert.throws(
    () =>
      store.command("other", c.id, {
        ...command,
        id: "steal",
        version: c.version,
      }),
    /Unauthorized/,
  );
  store.close();
  store = createConversations({ directory });
  c = store.get("owner", c.id);
  assert.equal(c.artifacts[1].progress.draft.done, true);
  c = store.send(
    "owner",
    c.id,
    "Make the remaining policy review shorter. Keep publication on hold and use no accounts.",
    c.version,
  );
  c = await store.run("owner", c.id, async ({ messages, artifacts }) => {
    assert.match(messages.at(-1).text, /publication on hold/);
    assert.equal(
      artifacts[1].items.find((i) => i.id === "draft").ownerMarkedDone,
      true,
    );
    assert.equal(
      artifacts[1].items.find((i) => i.id === "policy").ownerMarkedDone,
      false,
    );
    return {
      reply: "Only the unfinished local policy review remains.",
      questions: [],
      steps: [
        {
          id: "remaining",
          title: "Remaining review",
          capability: "local.checklist",
          content: JSON.stringify({
            items: [
              {
                id: "policy",
                text: "Review policy locally; do not change excluded workflow or publish",
              },
            ],
          }),
          dependsOn: [],
        },
      ],
    };
  });
  assert.equal(c.status, "review_required");
  assert.equal(c.artifacts.at(-1).verification.data.items.length, 1);
  store.close();
});
test("coverage audit derives verified, partial review, canceled, blocked and superseded state from evidence", () => {
  const base = {
    id: "c",
    mode: "fixture",
    revision: 2,
    messages: [
      { role: "user", text: "Original long guide" },
      { role: "assistant", text: "Draft" },
      { role: "user", text: "Short feature list instead; hold publication" },
    ],
    artifacts: [],
    status: "review_required",
  };
  let rows = taskCoverage([base]);
  assert.equal(rows[0].state, "retained-context");
  assert.equal(rows[1].state, "ready-for-review");
  rows = taskCoverage([{ ...base, status: "cancelled" }]);
  assert.equal(rows[1].state, "canceled");
  rows = taskCoverage([{ ...base, status: "source_changed" }]);
  assert.equal(rows[1].state, "blocked");
  rows = taskCoverage([
    {
      ...base,
      status: "completed",
      actionEvidence: [{ revision: 1, exitCode: 0 }],
    },
  ]);
  assert.equal(rows[1].state, "reviewed");
  rows = taskCoverage([
    {
      ...base,
      status: "completed",
      actionEvidence: [{ revision: 2, exitCode: 0, outputHash: "x" }],
    },
  ]);
  assert.equal(rows[1].state, "verified");
  assert.match(rows[1].note, /semantic completeness/);
});
test("empty private drafts cannot be marked prepared", () => {
  assert.throws(
    () => verifyPrivateWork("local.document", "  "),
    /EmptyPrivateDraft/,
  );
});

test("corrections receive exact versioned documents and checked schedule blocks after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bee-private-context-"));
  let store = createConversations({ directory });
  let c = store.create(
    "owner",
    "Prepare a local note and morning plan; no publication",
    "fixture",
  );
  const original =
    "Exact first version\nPreserve excluded approval workflow.\nFinal total: 90 units.";
  c = await store.run("owner", c.id, async () => ({
    reply: "Ready",
    questions: [],
    steps: [
      {
        id: "note",
        title: "Private note",
        capability: "local.document",
        content: original,
        dependsOn: [],
      },
      {
        id: "time",
        title: "Morning",
        capability: "local.schedule",
        content: JSON.stringify(schedule),
        dependsOn: [],
      },
    ],
  }));
  const firstRevision = c.revision;
  const firstArtifactId = c.artifacts[0].id;
  store.close();
  store = createConversations({ directory });
  c = store.get("owner", c.id);
  c = store.send(
    "owner",
    c.id,
    "Change final total to 85 units, keep all other wording and shorten the review block",
    c.version,
  );
  const revised = original.replace("90 units", "85 units");
  c = await store.run("owner", c.id, async ({ artifacts }) => {
    assert.equal(artifacts[0].id, firstArtifactId);
    assert.equal(artifacts[0].revision, firstRevision);
    assert.equal(artifacts[0].content, original);
    assert.equal(artifacts[0].digest, hash(original));
    assert.equal(artifacts[1].content, JSON.stringify(schedule));
    assert.equal(artifacts[1].digest, hash(JSON.stringify(schedule)));
    assert.deepEqual(
      artifacts[1].schedule.blocks.map(({ id, start, end, minutes }) => ({
        id,
        start,
        end,
        minutes,
      })),
      [
        { id: "draft", start: "09:00", end: "09:30", minutes: 30 },
        { id: "review", start: "09:30", end: "10:15", minutes: 45 },
      ],
    );
    assert.deepEqual(artifacts[1].schedule.unscheduled, schedule.unscheduled);
    return {
      reply: "Revised note",
      questions: [],
      steps: [
        {
          id: "revised",
          title: "Private note",
          capability: "local.document",
          content: revised,
          dependsOn: [],
        },
      ],
    };
  });
  const context = progressContext(c);
  assert.equal(context[0].content, original);
  assert.equal(context[2].content, revised);
  assert.notEqual(context[0].revision, context[2].revision);
  assert.notEqual(context[0].digest, context[2].digest);
  // Even the oldest retained version remains available; the envelope enforces the byte budget.
  assert.equal(
    progressContext({
      artifacts: [...c.artifacts, ...c.artifacts, ...c.artifacts],
    }).length,
    9,
  );
  store.close();
});
import { createBeeSourceClient } from "../src/bee-client.mjs";
test("recent Bee chooser requests five metadata rows and excludes transcripts before returning to the UI", async () => {
  const client = {
    api: {
      conversations: {
        list: async (options) => {
          assert.deepEqual(options, { limit: 5 });
          return {
            conversations: [
              {
                id: 1,
                title: "Chosen demo",
                transcriptions: [{ text: "must not leave adapter" }],
              },
            ],
          };
        },
      },
    },
  };
  const bee = createBeeSourceClient({ client });
  assert.deepEqual(await bee.listRecentConversations(), [
    { id: "1", title: "Chosen demo", startTime: null, state: "UNKNOWN" },
  ]);
});

test("reused step IDs retain revision-specific checklist history and owner progress after correction and reload", async () => {
  const { renderArtifactHistory, renderPrivateArtifact } = await import(
    "../public/visuals.mjs"
  );
  const directory = mkdtempSync(join(tmpdir(), "bee-artifact-history-"));
  let store = createConversations({ directory });
  let c = store.create("owner", "Prepare a workshop checklist", "fixture");
  const proposal = (changed = false) => ({
    reply: "Private checklist ready for review.",
    questions: [],
    steps: [
      {
        id: "list",
        title: "Workshop checklist",
        capability: "local.checklist",
        content: JSON.stringify({
          items: [
            { id: "paper", text: "Bring paper" },
            {
              id: "room",
              text: changed ? "Arrange six tables" : "Arrange three tables",
            },
          ],
        }),
        dependsOn: [],
      },
    ],
  });
  c = await store.run("owner", c.id, async () => proposal());
  const original = c.artifacts[0];
  for (const itemId of ["paper", "room"]) {
    c = store.command("owner", c.id, {
      id: "done-" + itemId,
      type: "checklist-item",
      artifactId: original.id,
      itemId,
      done: true,
      version: c.version,
    });
  }
  c = store.send(
    "owner",
    c.id,
    "Keep paper, change the room to six tables.",
    c.version,
  );
  c = await store.run("owner", c.id, async () => proposal(true));
  store.close();
  store = createConversations({ directory });
  try {
    c = store.get("owner", c.id);
    assert.equal(c.artifacts.length, 2);
    assert.equal(c.steps[0].id, original.stepId);
    assert.equal(c.artifacts[0].progress.paper.done, true);
    assert.equal(c.artifacts[0].progress.room.done, true);
    const current = c.artifacts[1];
    assert.notEqual(current.id, original.id);
    assert.notEqual(current.plan.revision, original.plan.revision);
    // Even unchanged text is not proof of completion in a newly prepared revision.
    assert.deepEqual(current.progress, {});
    const escape = (value) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const history = renderArtifactHistory(c, escape);
    assert.match(history, /Earlier revision/);
    assert.ok(history.includes(original.id));
    assert.ok(!history.includes(current.id));
    assert.match(history, /Arrange three tables/);
    assert.equal((history.match(/checked/g) ?? []).length, 2);
    assert.equal((history.match(/disabled/g) ?? []).length, 2);
    assert.doesNotMatch(history, /data-checklist-artifact/);
    const active = renderPrivateArtifact(current, escape);
    assert.match(active, /Arrange six tables/);
    assert.doesNotMatch(active, /checked/);
    assert.match(active, /data-checklist-artifact/);
  } finally {
    store.close();
  }
});

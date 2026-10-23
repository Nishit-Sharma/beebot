import { hash } from "../src/demo-runner.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGuidancePack,
  validateGuidancePack,
  selectGuidance,
} from "../src/bee-guidance.mjs";
import {
  buildCompanionRequest,
  measureProposalInput,
} from "../src/proposal-request.mjs";
import { createConversations } from "../src/conversations.mjs";
import { isolationOverrides } from "../src/codex-provider.mjs";
const pack = () =>
  JSON.parse(
    readFileSync(new URL("../guidance/bee-pack.json", import.meta.url), "utf8"),
  );
const input = (text) => ({
  messages: [{ role: "user", text }],
  memory: [],
  artifacts: [],
  intentChanges: [],
});
test("guidance selects deterministic core modules and optional UI only for applicable owner requests", () => {
  const core = selectGuidance(input("Plan a private beginner workshop."));
  assert.deepEqual(
    core.modules.map((m) => m.id),
    ["bee.outcomes", "bee.evidence", "bee.drafting"],
  );
  const ui = selectGuidance(
    input("Review the frontend login form accessibility."),
  );
  assert.deepEqual(
    ui.modules.map((m) => m.id),
    [...core.modules.map((m) => m.id), "bee.ui-review"],
  );
  assert.deepEqual(
    ui,
    selectGuidance(input("Review the frontend login form accessibility.")),
  );
  const unrelated = input("Draft a meal plan");
  unrelated.memory = [{ text: "frontend UI accessibility" }];
  assert.equal(selectGuidance(unrelated).modules.length, 3);
  const replaced = input("Review the frontend form");
  replaced.messages.push({
    role: "user",
    text: "Replace that with a meal plan",
  });
  replaced.intentChanges = [
    {
      type: "replace-request",
      source: "owner-command",
      scope: "entire-message",
      actor: "owner",
      requestNumber: 1,
      replacementRequestNumber: 2,
      requestDigest: hash(replaced.messages[0].text),
      replacementRequestDigest: hash(replaced.messages[1].text),
    },
  ];
  assert.equal(selectGuidance(replaced).modules.length, 3);
});
test("malformed, altered, unexpected and unresolved dependency modules fail closed", () => {
  assert.equal(loadGuidancePack().modules.length, 4);
  for (const mutate of [
    (p) => (p.modules[0].text += " Altered"),
    (p) => p.modules.pop(),
    (p) => (p.modules[0].dependencies = ["missing"]),
    (p) => (p.modules[0].capabilities = ["shell"]),
    (p) => (p.modules[0].script = "installer"),
    (p) => (p.modules[0].sha256 = "0".repeat(64)),
    (p) => (p.version = "2.0.0"),
    (p) => p.modules.push(p.modules[0]),
  ]) {
    const p = pack();
    mutate(p);
    assert.throws(() => validateGuidancePack(p), /Guidance/);
  }
  assert.throws(() => validateGuidancePack({}), /Guidance/);
});
test("complete Unicode prompt byte limit includes instructions, selected guidance, schema and request wrapper", () => {
  const r = buildCompanionRequest(input("Review UI 🐝"));
  assert.equal(r.inputBytes, measureProposalInput(r));
  assert.ok(r.instructions.includes("bee.ui-review"));
  assert.ok(r.inputBytes > Buffer.byteLength(r.text));
  assert.equal(r.provenance.modules.length, 4);
  const small = buildCompanionRequest(input("a"));
  const fit = 32000 - small.inputBytes;
  const exact = buildCompanionRequest(input("a" + "x".repeat(fit)));
  assert.equal(exact.inputBytes, 32000);
  assert.throws(
    () => buildCompanionRequest(input("a" + "x".repeat(fit) + "🐝")),
    /ContextBudget/,
  );
  assert.throws(
    () => buildCompanionRequest(input("🐝".repeat(8000))),
    /ContextBudget/,
  );
});
test("guidance request revision is durable across restart, failure and explicit retry without tool or consent changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bee-guidance-"));
  let s = createConversations({ directory });
  let c = s.create(
    "owner",
    "Draft an accessible login UI brief, no account changes.",
    "codex",
  );
  const first = c.queuedGuidance;
  assert.equal(first.revision, c.revision);
  assert.equal(first.modules.length, 4);
  s.close();
  s = createConversations({ directory });
  try {
    c = await s.run("owner", c.id, async (request) => {
      assert.deepEqual(request.requestGuidance, first);
      throw Error("Synthetic provider failure");
    });
    assert.equal(c.status, "failed");
    assert.deepEqual(c.guidanceRequests[0].modules, first.modules);
    c = s.send(
      "owner",
      c.id,
      "Keep the same scope and write the brief.",
      c.version,
    );
    const second = c.queuedGuidance;
    assert.equal(second.revision, first.revision + 1);
    assert.equal(second.packHash, first.packHash);
    assert.notEqual(second.requestDigest, first.requestDigest);
    c = await s.run("owner", c.id, async (request) => {
      assert.deepEqual(request.requestGuidance, second);
      return {
        reply: "A source-based brief; rendered review remains unverified.",
        questions: [],
        steps: [
          {
            id: "brief",
            title: "UI brief",
            capability: "local.document",
            content:
              "Source-level review only. No browser inspection or changes performed.",
            dependsOn: [],
          },
        ],
      };
    });
    assert.equal(c.status, "review_required");
    assert.deepEqual(c.messages.at(-1).guidance, second);
    assert.deepEqual(c.steps[0].guidance, second);
    assert.deepEqual(c.artifacts[0].plan.guidance, second);
    assert.deepEqual(
      c.guidanceRequests.map((g) => g.revision),
      [first.revision, second.revision],
    );
    assert.equal(
      isolationOverrides["features.skip_host_skill_discovery"],
      true,
    );
    assert.equal(isolationOverrides["features.shell_tool"], false);
    assert.equal(isolationOverrides["features.browser_use"], false);
    assert.equal(isolationOverrides["features.plugins"], false);
    assert.equal(c.approvals.length, 0);
  } finally {
    s.close();
  }
});

test("tampered recorded guidance blocks a queued request before inference and a fresh owner retry restores an exact binding", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "bee-guidance-revision-"));
  let store = createConversations({ directory });
  let c = store.create("owner", "Draft a local checklist", "codex");
  store.close();
  const db = new DatabaseSync(join(directory, "conversations.sqlite"));
  c.queuedGuidance.modules[0].sha256 = "0".repeat(64);
  db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
    JSON.stringify(c),
    c.id,
  );
  db.close();
  store = createConversations({ directory });
  try {
    let calls = 0;
    c = await store.run("owner", c.id, async () => {
      calls++;
      throw Error("Should not run");
    });
    assert.equal(calls, 0);
    assert.equal(c.status, "failed");
    assert.match(c.error, /GuidanceRequestRevisionMismatch/);
    c = store.send("owner", c.id, "Retry the same local-only task.", c.version);
    c = await store.run("owner", c.id, async (request) => {
      calls++;
      return { reply: "A draft only.", questions: [], steps: [] };
    });
    assert.equal(calls, 1);
    assert.equal(c.status, "ready");
    assert.equal(
      c.queuedGuidance.modules[0].sha256,
      loadGuidancePack().modules[0].sha256,
    );
  } finally {
    store.close();
  }
});

test("a queued request from pack1.0 is not silently upgraded; explicit retry binds readiness pack1.1", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "bee-guidance-upgrade-"));
  let store = createConversations({ directory });
  let c = store.create(
    "owner",
    "Prepare a real connected test but do not log in for me.",
    "codex",
  );
  store.close();
  const db = new DatabaseSync(join(directory, "conversations.sqlite"));
  c.queuedGuidance.packVersion = "1.0.0";
  c.queuedGuidance.modules = c.queuedGuidance.modules.map((m) => ({
    ...m,
    version: "1.0.0",
  }));
  db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
    JSON.stringify(c),
    c.id,
  );
  db.close();
  store = createConversations({ directory });
  try {
    let calls = 0;
    c = await store.run("owner", c.id, async () => {
      calls++;
      throw Error("unapproved revision must not run");
    });
    assert.equal(calls, 0);
    assert.match(c.error, /GuidanceRequestRevisionMismatch/);
    c = store.send(
      "owner",
      c.id,
      "Retry preparation only; login remains postponed.",
      c.version,
    );
    assert.equal(c.queuedGuidance.packVersion, "1.2.0");
    c = await store.run("owner", c.id, async (request) => {
      calls++;
      assert.equal(request.requestGuidance.packVersion, "1.2.0");
      return {
        reply:
          "Prepared for a connection test; real device and provider evidence remain pending.",
        questions: [],
        steps: [],
      };
    });
    assert.equal(calls, 1);
    assert.equal(c.status, "ready");
  } finally {
    store.close();
  }
});

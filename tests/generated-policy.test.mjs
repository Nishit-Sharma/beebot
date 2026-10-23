import { macSandboxTest } from "./mac-sandbox.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversations } from "../src/conversations.mjs";
import { compileExpression } from "../src/generated-policy.mjs";
import { validateProposal } from "../src/capabilities.mjs";
const field = (field) => ({ field }),
  value = (value) => ({ value }),
  op = (op, ...args) => ({ op, args });
for (const [name, recipe] of [
  [
    "discount threshold",
    {
      expression: op(
        "if",
        op("gte", field("total"), value(100)),
        op("multiply", field("total"), value(0.9)),
        field("total"),
      ),
      cases: [
        { name: "below threshold", input: { total: 90 }, expected: 90 },
        { name: "boundary discount", input: { total: 100 }, expected: 90 },
        { name: "above threshold", input: { total: 200 }, expected: 180 },
      ],
    },
  ],
  [
    "eligibility boundary",
    {
      expression: op(
        "and",
        op("gte", field("age"), value(18)),
        op("not", field("blocked")),
      ),
      cases: [
        {
          name: "too young",
          input: { age: 17, blocked: false },
          expected: false,
        },
        {
          name: "exactly adult",
          input: { age: 18, blocked: false },
          expected: true,
        },
        {
          name: "blocked adult",
          input: { age: 25, blocked: true },
          expected: false,
        },
      ],
    },
  ],
  [
    "text normalization",
    {
      expression: op("lower", op("trim", field("name"))),
      cases: [
        { name: "mixed case", input: { name: "  HELLo  " }, expected: "hello" },
        { name: "empty", input: { name: "" }, expected: "" },
      ],
    },
  ],
])
  macSandboxTest(
    "generated " +
      name +
      " requires actual failure and separate snapshot-bound patch approval",
    async () => {
      const s = createConversations({
        directory: mkdtempSync(join(tmpdir(), "bee-generated-")),
      });
      let c = s.create("a", "Confirmed " + name, "fixture");
      c = await s.run("a", c.id, async () => ({
        reply: "Proposed confirmed cases and pure policy",
        questions: [],
        steps: [
          {
            id: "policy",
            title: name,
            capability: "demo.policy",
            content: JSON.stringify(recipe),
            dependsOn: [],
          },
        ],
      }));
      const digest = c.steps[0].digest;
      c = s.command("a", c.id, {
        id: "test",
        version: c.version,
        type: "approve",
        digest,
      });
      c = await s.runAction("a", c.id);
      assert.equal(c.steps[0].evidence[0].exitCode, 1, c.error);
      assert.equal(c.steps[0].stage, "patch");
      assert.notEqual(c.steps[0].digest, digest);
      assert.throws(
        () =>
          s.command("a", c.id, {
            id: "stale",
            version: c.version,
            type: "approve",
            digest,
          }),
        /ApprovalMismatch/,
      );
      c = s.command("a", c.id, {
        id: "patch",
        version: c.version,
        type: "approve",
        digest: c.steps[0].digest,
      });
      c = await s.runAction("a", c.id);
      assert.equal(c.status, "review_required", c.error);
      assert.equal(c.steps[0].evidence[1].exitCode, 0);
      assert.equal(c.actionEvidence.length, 2);
      s.close();
    },
  );
test("generated path rejects code execution, path traversal and oversized expression trees", () => {
  assert.throws(
    () => compileExpression({ op: "exec", args: [{ value: "cat ~/.ssh" }] }),
    /InvalidOperator/,
  );
  assert.throws(
    () => compileExpression({ field: "constructor" }),
    /InvalidField/,
  );
  let tree = { value: 0 };
  for (let i = 0; i < 20; i++) tree = op("add", tree, value(1));
  assert.throws(() => compileExpression(tree), /InvalidExpression/);
  assert.throws(
    () =>
      validateProposal({
        reply: "x",
        questions: [],
        steps: [
          {
            id: "../../escape",
            title: "bad",
            content: "x",
            capability: "local.document",
            dependsOn: [],
          },
        ],
      }),
    /InvalidStep/,
  );
});
import { validateRecipe, bindOwnerChecks } from "../src/generated-policy.mjs";
test("owner acceptance rejects the live-observed discount-amount versus final-total semantic mismatch", () => {
  const wrong = validateRecipe(
    JSON.stringify({
      cases: [
        { name: "below unchanged", input: { total: 99.99 }, expected: 0 },
        { name: "at threshold", input: { total: 100 }, expected: 10 },
      ],
      expression: { value: 0 },
    }),
  );
  assert.throws(
    () =>
      bindOwnerChecks(wrong, [
        {
          name: "final total unchanged",
          input: { total: 99.99 },
          expected: 99.99,
        },
      ]),
    /OwnerAcceptanceConflictsWithProposedCase/,
  );
  const right = validateRecipe(
    JSON.stringify({
      cases: [
        { name: "below", input: { total: 99.99 }, expected: 99.99 },
        { name: "at threshold", input: { total: 100 }, expected: 90 },
      ],
      expression: { field: "total" },
    }),
  );
  const bound = bindOwnerChecks(right, [
    { name: "another independent input", input: { total: 50 }, expected: 50 },
  ]);
  assert.equal(bound.cases.at(-1).expected, 50);
  assert.equal(right.cases.length, 2);
});

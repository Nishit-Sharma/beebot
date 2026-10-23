import { createHarness } from "../src/harness.mjs";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "bee-demo-proof-"));
const h = createHarness({ directory });
const run = Effect.runPromise;
let t = await run(
  h.create(
    "demo-owner",
    "When a reminder is due exactly now, show it as due. Completed reminders must never be due.",
    "fixture",
  ),
);
t = await run(
  h.command("demo-owner", t.id, {
    id: "confirm",
    version: t.version,
    type: "confirm",
    inclusive: true,
    excludeCompleted: true,
  }),
);
t = await run(
  h.command("demo-owner", t.id, {
    id: "approve-test",
    version: t.version,
    type: "approve",
    digest: t.plan.digest,
  }),
);
t = await run(h.runNext(t.id));
if (t.status !== "patch_approval")
  throw Error(t.error ?? "Expected observed failure");
const patch = t.plan;
t = await run(
  h.command("demo-owner", t.id, {
    id: "approve-patch",
    version: t.version,
    type: "approve",
    digest: patch.digest,
  }),
);
t = await run(h.runNext(t.id));
if (t.status !== "review_required")
  throw Error(t.error ?? "Expected passing evidence");
const artifact = {
  input: "simulated Bee fixture",
  interpreter: "local authored template; no model inference",
  task: t,
  approvedPatch: patch,
  workspace: directory,
  scope:
    "Authored reminder-policy test and patch only. No device, publish or merge.",
};
mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/workflow-proof.json",
  JSON.stringify(artifact, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      status: t.status,
      baselineExit: t.evidence[0].exitCode,
      patchedExit: t.evidence[1].exitCode,
      sandboxed: t.evidence.every((e) => e.sandboxed),
      artifact: "evidence/workflow-proof.json",
    },
    null,
    2,
  ),
);
h.close();

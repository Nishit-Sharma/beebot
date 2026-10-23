import { codexBinary } from "../src/runtime-paths.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createBeeContext, beePolicyFixture } from "../src/bee-context.mjs";
import { createConversations } from "../src/conversations.mjs";
import { fixtureCompanion } from "../src/fixture-companion.mjs";
const directory = mkdtempSync(join(tmpdir(), "bee-readiness-"));
let inbox, store;
const report = {
  mode: "offline-fixture-readiness",
  status: "checking-offline-prerequisites",
  endToEndVerified: false,
  manualStepsRemaining: [
    "When the Watch returns: Bee iPhone/Watch setup and Developer Mode",
    "User approves Bee CLI login",
    "User explicitly acknowledges reviewed guidance before starting Companion",
    "Start Companion and approve only the chosen source sharing",
    "Observe actual Watch-to-model-to-result and correction",
  ],
  accountCalls: 0,
  modelCalls: 0,
  checks: [],
  notVerified: [
    "actual app launch and use",
    "live Luna inference",
    "Bee login",
    "real recorded/processed Watch data",
    "native-agent eligibility/tool controls",
    "hardware latency",
    "system launch service",
  ],
};
try {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw Error("Node24Required");
  report.checks.push("Node version");
  for (const [name, relative, expected] of [
    ["Effect", "../node_modules/effect/package.json", "4.0.5"],
    ["Bee CLI", "../node_modules/@beeai/cli/package.json", "0.8.0"],
  ]) {
    const installed = JSON.parse(
      readFileSync(new URL(relative, import.meta.url), "utf8"),
    );
    if (installed.version !== expected)
      throw Error(name + "DependencyVersionMismatch");
    report.checks.push(name + " " + expected + " installed");
  }
  const selectedCodex = codexBinary();
  const codexVersion = await promisify(execFile)(selectedCodex, ["--version"], {
    timeout: 5000,
    maxBuffer: 4096,
  });
  report.selectedCodexVersion = codexVersion.stdout.trim();
  report.selectedCodexBinary = selectedCodex;
  if (!codexVersion.stdout.includes("codex-cli"))
    throw Error("CodexCliUnavailable");
  report.checks.push(
    "existing Codex binary version only; no account/model access",
  );
  const version = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../src/bee-command.mjs", import.meta.url)),
      "version",
    ],
    { timeout: 5000, maxBuffer: 4096 },
  );
  if (!version.stdout.includes("@beeai/cli"))
    throw Error("OfficialBeeCliVersionUnavailable");
  report.checks.push("official Bee CLI version only; no account access");
  inbox = createBeeContext({ directory });
  store = createConversations({
    directory,
    memoryRead: (_, id) => inbox.memory(id),
  });
  const source = inbox.ingest(beePolicyFixture);
  const claim = inbox.claim(
    source.id,
    source.revision,
    (s, id) =>
      store.create(
        "readiness",
        "Test this selected synthetic requirement",
        "fixture",
        ["bee:" + s.id],
        "policy",
        { id: s.id, simulated: true },
        id,
      ).id,
  );
  let c = await store.run("readiness", claim.conversationId, fixtureCompanion);
  if (c.status !== "clarifying") throw Error("ClarificationGateFailed");
  report.checks.push("source selection and clarification");
  c = store.send(
    "readiness",
    c.id,
    "Confirm exactly 100 included, lower totals unchanged.",
    c.version,
  );
  c = await store.run("readiness", c.id, fixtureCompanion);
  c = store.command("readiness", c.id, {
    id: "test",
    version: c.version,
    type: "approve",
    digest: c.steps[0].digest,
  });
  c = await store.runAction("readiness", c.id);
  if (c.actionEvidence?.[0]?.exitCode !== 1 || c.steps[0].stage !== "patch")
    throw Error("SandboxBaselineGateFailed");
  c = store.command("readiness", c.id, {
    id: "patch",
    version: c.version,
    type: "approve",
    digest: c.steps[0].digest,
  });
  c = await store.runAction("readiness", c.id);
  if (c.status !== "review_required" || c.actionEvidence.at(-1).exitCode !== 0)
    throw Error("SandboxRetestGateFailed");
  report.checks.push(
    "actual sandbox failure, separate synthetic approval, passing retest, review gate",
  );
  report.readyForAccountAndWatchTest = true;
  report.status = "prepared-for-connection-test";
} catch (error) {
  report.readyForAccountAndWatchTest = false;
  report.status = "blocked-offline-preflight";
  report.blocker = String(error.message);
  process.exitCode = 1;
} finally {
  store?.close();
  inbox?.close();
  rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  hash,
  baseline,
  corrected,
  casesFor,
  prepareDemo,
  snapshot,
  applyDemo,
  runDemo,
} from "./demo-runner.mjs";
const Command = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  type: Schema.String,
  digest: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  inclusive: Schema.optionalKey(Schema.Boolean),
  excludeCompleted: Schema.optionalKey(Schema.Boolean),
});
const Stored = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  revision: Schema.Number,
  version: Schema.Number,
  status: Schema.String,
  text: Schema.String,
  evidence: Schema.Array(Schema.Unknown),
  events: Schema.Array(Schema.Unknown),
});
export function createHarness({
  directory,
  runner = runDemo,
  clock = Date.now,
}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "companion.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands(owner TEXT,id TEXT,digest TEXT,result TEXT,PRIMARY KEY(owner,id)); CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,owner TEXT,data TEXT);",
  );
  const controllers = new Map();
  const read = (id) => {
    const row = db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    if (!row) throw Error("NotFound");
    const t = JSON.parse(row.data);
    t.approvalHistory ??= [];
    Schema.decodeUnknownSync(Stored)(t);
    return t;
  };
  const owned = (owner, id) => {
    const t = read(id);
    if (t.owner !== owner) throw Error("Unauthorized");
    return t;
  };
  const path = (t) => join(directory, "workspaces", t.id);
  const event = (t, message) => {
    t.events.push({
      sequence: t.events.length + 1,
      at: new Date(clock()).toISOString(),
      message,
      revision: t.revision,
    });
  };
  const save = (t) => {
    db.prepare(
      "INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(t.id, t.owner, JSON.stringify(t));
    return t;
  };
  const named = (name, fn) =>
    Effect.fn(name)((...args) =>
      Effect.try({ try: () => fn(...args), catch: (e) => e }),
    );
  const plan = (t, kind) => {
    const p = {
      kind,
      taskId: t.id,
      revision: t.revision,
      sourceHash: snapshot(path(t)),
      captureHash: hash(t.capture ?? t.text),
      cases: casesFor(t.rule),
      target: "isolated reminder demo",
      files: kind === "patch" ? ["reminders.mjs"] : ["acceptance.mjs"],
      network: false,
      expiresAt: clock() + 600000,
      beforeSource: kind === "patch" ? baseline : null,
      content:
        kind === "patch"
          ? corrected(t.rule)
          : "Run the fixed acceptance test recipe",
    };
    return { ...p, digest: hash(p) };
  };
  // Restart never guesses whether an in-flight mutation completed.
  for (const row of db.prepare("SELECT data FROM tasks").all()) {
    const t = JSON.parse(row.data);
    if (
      [
        "interpreting",
        "testing",
        "applying",
        "retesting",
        "pausing",
        "cancelling",
      ].includes(t.status)
    ) {
      t.status = "reconciliation_required";
      t.version++;
      t.plan = null;
      event(
        t,
        "Worker restarted during an attempt. Inspect outcome before continuing.",
      );
      save(t);
    }
  }
  const create = named(
    "Companion.create",
    (
      owner,
      text,
      source = "fixture",
      proposal = null,
      capture = null,
      modelRequested = false,
    ) => {
      if (
        typeof owner !== "string" ||
        !owner ||
        typeof text !== "string" ||
        !text.trim() ||
        Buffer.byteLength(text) > 8192 ||
        !["fixture", "typed", "bee-live-selected", "bee-recovered"].includes(
          source,
        )
      )
        throw Error("InvalidInput");
      const t = {
        id: randomUUID(),
        owner,
        revision: 1,
        version: 1,
        status: modelRequested ? "interpretation_queued" : "clarifying",
        text,
        source,
        simulated: source === "fixture",
        recovered: source === "bee-recovered",
        proposal,
        capture,
        workflow:
          /\breminders?\b/i.test(text) && /\bdue\b/i.test(text)
            ? "reminder-policy"
            : "unsupported",
        approvalHistory: [],
        rule: { inclusive: true, excludeCompleted: true },
        plan: null,
        evidence: [],
        events: [],
        attempts: 0,
        phase: "baseline",
        desired: "run",
        createdAt: new Date(clock()).toISOString(),
      };
      event(
        t,
        modelRequested
          ? "Request saved before model interpretation. No action authorized."
          : "Request selected. Local template interpreter; no model used. Confirm examples before execution.",
      );
      return save(t);
    },
  );
  const get = named("Companion.get", owned);
  const list = named("Companion.list", (owner) =>
    db
      .prepare("SELECT data FROM tasks WHERE owner=? ORDER BY rowid DESC")
      .all(owner)
      .map((r) => JSON.parse(r.data)),
  );
  const command = Effect.fn("Companion.command")((owner, id, input) =>
    Effect.gen(function* () {
      const c = yield* Schema.decodeUnknownEffect(Command)(input);
      return yield* Effect.try({
        try: () => {
          if (!c.id || c.id.length > 100) throw Error("InvalidInput");
          const d = hash({ taskId: id, ...c });
          const prev = db
            .prepare(
              "SELECT digest,result FROM commands WHERE owner=? AND id=?",
            )
            .get(owner, c.id);
          if (prev) {
            if (prev.digest !== d) throw Error("IdempotencyConflict");
            owned(owner, id);
            return JSON.parse(prev.result);
          }
          db.exec("BEGIN IMMEDIATE");
          try {
            let t = owned(owner, id);
            if (t.version !== c.version) throw Error("StaleRevision");
            if (["completed", "cancelled"].includes(t.status))
              throw Error("TaskClosed");
            switch (c.type) {
              case "confirm": {
                if (
                  t.status !== "clarifying" ||
                  typeof c.inclusive !== "boolean" ||
                  typeof c.excludeCompleted !== "boolean"
                )
                  throw Error("InvalidState");
                if (t.workflow !== "reminder-policy")
                  throw Error(
                    "UnsupportedCapability: local template supports reminder due-time requirements only",
                  );
                t.rule = {
                  inclusive: c.inclusive,
                  excludeCompleted: c.excludeCompleted,
                };
                prepareDemo(path(t), t.rule);
                t.phase = "baseline";
                t.plan = plan(t, "test");
                t.status = "acceptance_approval";
                t.approvalHistory.push({
                  plan: structuredClone(t.plan),
                  decision: "pending",
                });
                event(
                  t,
                  "Acceptance examples prepared. Approval allows the fixed demo test only.",
                );
                break;
              }
              case "approve": {
                if (
                  !["acceptance_approval", "patch_approval"].includes(t.status)
                )
                  throw Error("InvalidState");
                if (!t.plan || t.plan.digest !== c.digest)
                  throw Error("ApprovalMismatch");
                if (t.plan.expiresAt <= clock()) throw Error("ApprovalExpired");
                if (snapshot(path(t)) !== t.plan.sourceHash)
                  throw Error("SnapshotChanged");
                t.approvalHistory.push({
                  plan: structuredClone(t.plan),
                  decision: "approved",
                  actor: owner,
                  at: clock(),
                });
                t.grant = {
                  digest: t.plan.digest,
                  revision: t.revision,
                  consumedAt: clock(),
                };
                t.phase = t.status === "patch_approval" ? "patch" : "baseline";
                t.status = "queued";
                event(
                  t,
                  "Exact plan approved once. Queued for the local worker.",
                );
                break;
              }
              case "pause": {
                if (["paused", "pausing"].includes(t.status)) break;
                if (
                  ["interpreting", "testing", "retesting", "applying"].includes(
                    t.status,
                  )
                ) {
                  t.desired = "pause";
                  t.status = "pausing";
                } else {
                  t.resumeStatus = t.status;
                  t.status = "paused";
                  t.desired = "pause";
                }
                event(t, "Pause requested; no new steps will start.");
                break;
              }
              case "resume": {
                if (t.status !== "paused") throw Error("InvalidState");
                t.status = t.resumeStatus ?? "clarifying";
                t.desired = "run";
                event(t, "Resumed. Current plan and source will be rechecked.");
                break;
              }
              case "cancel": {
                t.desired = "cancel";
                t.plan = null;
                t.grant = null;
                t.status = controllers.has(id) ? "cancelling" : "cancelled";
                event(t, "Cancellation requested; unused authority revoked.");
                break;
              }
              case "steer": {
                if (controllers.has(id)) throw Error("PauseBeforeSteering");
                if (
                  typeof c.text !== "string" ||
                  !c.text.trim() ||
                  Buffer.byteLength(c.text) > 8192
                )
                  throw Error("InvalidInput");
                t.text = c.text;
                t.workflow =
                  /\breminders?\b/i.test(c.text) && /\bdue\b/i.test(c.text)
                    ? "reminder-policy"
                    : "unsupported";
                t.proposal = null;
                t.revision++;
                t.plan = null;
                t.grant = null;
                t.evidence = [];
                t.attempts = 0;
                t.status = "clarifying";
                t.desired = "run";
                event(
                  t,
                  "Request revised. Prior approvals invalidated; confirm new acceptance examples.",
                );
                break;
              }
              case "accept": {
                if (t.status !== "review_required") throw Error("InvalidState");
                t.status = "completed";
                event(
                  t,
                  "You accepted the review artifact. Nothing was published or merged.",
                );
                break;
              }
              case "reconcile": {
                if (t.status !== "reconciliation_required")
                  throw Error("InvalidState");
                if (t.desired === "cancel") {
                  t.status = "cancelled";
                  event(
                    t,
                    "Cancellation retained after restart. No step replayed.",
                  );
                } else {
                  t.revision++;
                  t.status = "clarifying";
                  t.plan = null;
                  t.grant = null;
                  event(
                    t,
                    "Prior attempt preserved as uncertain. Fresh acceptance required; no mutation replayed.",
                  );
                }
                break;
              }
              default:
                throw Error("UnsupportedCommand");
            }
            t.version++;
            save(t);
            db.prepare("INSERT INTO commands VALUES(?,?,?,?)").run(
              owner,
              c.id,
              d,
              JSON.stringify(t),
            );
            db.exec("COMMIT");
            if (["pause", "cancel"].includes(c.type))
              controllers.get(id)?.abort();
            return t;
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
        },
        catch: (e) => e,
      });
    }),
  );
  const runNext = Effect.fn("Companion.runNext")((id) =>
    Effect.tryPromise({
      try: async () => {
        let t = read(id);
        if (
          t.status !== "queued" ||
          t.desired !== "run" ||
          controllers.size > 0
        )
          return t;
        if (
          !t.grant ||
          t.grant.revision !== t.revision ||
          t.grant.digest !== t.plan?.digest
        )
          throw Error("ApprovalMismatch");
        if (
          clock() >= t.plan.expiresAt ||
          snapshot(path(t)) !== t.plan.sourceHash
        ) {
          t.status = "clarifying";
          t.plan = null;
          t.grant = null;
          t.version++;
          event(
            t,
            "Approval expired or workspace changed before launch. Confirm again.",
          );
          return save(t);
        }
        if (t.attempts >= 3) {
          t.status = "failed";
          t.error = "BudgetExceeded";
          t.version++;
          return save(t);
        }
        const ctrl = new AbortController();
        controllers.set(id, ctrl);
        const revision = t.revision;
        t.status = t.phase === "patch" ? "applying" : "testing";
        t.attempts++;
        t.version++;
        t.attemptId = randomUUID();
        event(t, "Local sandbox attempt started.");
        save(t);
        try {
          if (t.phase === "patch") {
            applyDemo(path(t), t.rule, t.plan.sourceHash);
            t.status = "retesting";
            t.version++;
            event(
              t,
              "Approved fixed patch applied; running acceptance and regression cases.",
            );
            save(t);
          }
          const receipt = await runner(path(t), { signal: ctrl.signal });
          t = read(id);
          if (t.revision !== revision) throw Error("StaleRevision");
          t.evidence.push({ ...receipt, attemptId: t.attemptId, revision });
          if (t.desired === "cancel") {
            t.status = "cancelled";
            event(t, "Worker stopped. Observed evidence retained.");
          } else if (t.desired === "pause") {
            t.status = "paused";
            t.resumeStatus =
              receipt.exitCode === 0 ? "review_required" : "patch_approval";
            if (receipt.exitCode !== 0) t.plan = plan(t, "patch");
            event(t, "Pause confirmed. Evidence retained.");
          } else if (receipt.exitCode === 0) {
            t.status = "review_required";
            t.plan = null;
            event(t, "All confirmed cases passed. Ready for human review.");
          } else {
            t.status = "patch_approval";
            t.plan = plan(t, "patch");
            t.approvalHistory.push({
              plan: structuredClone(t.plan),
              decision: "pending",
            });
            event(
              t,
              "Test failed. A fixed one-file patch is proposed; approval required.",
            );
          }
        } catch (e) {
          t = read(id);
          t.error = String(e.message ?? e).slice(0, 500);
          if (t.desired === "cancel") t.status = "cancelled";
          else if (t.desired === "pause") {
            t.status = "paused";
            t.resumeStatus = "clarifying";
            t.plan = null;
            t.grant = null;
          } else t.status = "failed";
          event(
            t,
            t.status === "failed"
              ? "Attempt failed: " + t.error
              : "Worker interruption confirmed. Confirm again before another attempt.",
          );
        } finally {
          controllers.delete(id);
          t.version++;
          save(t);
        }
        return t;
      },
      catch: (e) => e,
    }),
  );

  const interpretNext = Effect.fn("Companion.interpretNext")((id, interpret) =>
    Effect.tryPromise({
      try: async () => {
        let t = read(id);
        if (
          t.status !== "interpretation_queued" ||
          t.desired !== "run" ||
          controllers.size
        )
          return t;
        const ctrl = new AbortController();
        controllers.set(id, ctrl);
        const revision = t.revision;
        t.status = "interpreting";
        t.version++;
        event(
          t,
          "Interpreting selected text via your connected ChatGPT plan. No tool execution authorized.",
        );
        save(t);
        try {
          const proposal = await interpret(t.text, { signal: ctrl.signal });
          t = read(id);
          if (t.revision !== revision) throw Error("StaleRevision");
          t.proposal = proposal;
          t.workflow = proposal.workflow;
          if (t.desired === "run") {
            t.status = "clarifying";
            event(
              t,
              "Model proposal received. Review the interpretation and confirm acceptance before action.",
            );
          } else if (t.desired === "cancel") t.status = "cancelled";
          else {
            t.status = "paused";
            t.resumeStatus = "clarifying";
          }
        } catch (e) {
          t = read(id);
          t.error = String(e.message ?? e).slice(0, 500);
          t.status =
            t.desired === "cancel"
              ? "cancelled"
              : t.desired === "pause"
                ? "paused"
                : "failed";
          if (t.status === "paused") t.resumeStatus = "interpretation_queued";
          event(t, "Interpretation stopped: " + t.error);
        } finally {
          controllers.delete(id);
          t.version++;
          save(t);
        }
        return t;
      },
      catch: (e) => e,
    }),
  );
  const memory = named("Companion.memory", (owner, action, input = {}) => {
    if (action === "list")
      return db
        .prepare("SELECT data FROM memories WHERE owner=?")
        .all(owner)
        .map((r) => JSON.parse(r.data))
        .filter((m) => !m.expiresAt || m.expiresAt > clock());
    if (action === "save-conversation") {
      const c = input.conversation;
      if (!c || c.owner !== owner) throw Error("Unauthorized");
      if (c.status !== "completed") throw Error("ReviewFirst");
      const currentIds = new Set(
        (c.steps ?? [])
          .filter((step) => step.status === "completed")
          .map((step) => step.receipt?.artifactId)
          .filter(Boolean),
      );
      const artifacts = c.artifacts.filter((a) => currentIds.has(a.id));
      if (artifacts.length !== currentIds.size)
        throw Error("NoCurrentAcceptedOutputs");
      const executionReceipts = (c.steps ?? [])
        .filter(
          (step) =>
            step.status === "completed" &&
            step.receipt &&
            !step.receipt.artifactId,
        )
        .map((step) => ({
          stepId: step.id,
          title: step.title,
          revision: step.revision ?? null,
          capability: step.capability,
          planDigest: step.digest,
          receipt: step.receipt,
        }));
      const requests = c.messages.filter((m) => m.role === "user");
      const instructions = requests.map((m, index) => {
        const number = index + 1;
        const replacement = (c.intentChanges ?? []).find(
          (change) =>
            change.type === "replace-request" &&
            change.source === "owner-command" &&
            change.scope === "entire-message" &&
            change.actor === owner &&
            change.requestNumber === number &&
            change.requestDigest === hash(m.text) &&
            Number.isInteger(change.replacementRequestNumber) &&
            change.replacementRequestNumber > number &&
            change.replacementRequestNumber <= requests.length,
        );
        return {
          number,
          text: m.text,
          digest: hash(m.text),
          ...(replacement
            ? { replacedBy: replacement.replacementRequestNumber }
            : {}),
        };
      });
      const text = [
        "Accepted current outputs · conversation revision " + c.revision,
        ...artifacts.map(
          (a) =>
            a.title +
            " (artifact revision " +
            (a.plan?.revision ?? a.revision ?? "unknown") +
            ")\n" +
            a.content,
        ),
        ...executionReceipts.map(
          (step) =>
            "Accepted execution receipt (revision " +
            (step.revision ?? "unknown") +
            "): " +
            step.title +
            "\n" +
            JSON.stringify(step.receipt),
        ),
        "Owner instructions in order · later corrections apply; retain independent constraints. Earlier requests are context, not additional current outputs.",
        ...instructions.map(
          (m) =>
            "Request " +
            m.number +
            (m.replacedBy
              ? " (explicitly replaced by request " + m.replacedBy + ")"
              : "") +
            ": " +
            m.text,
        ),
      ].join("\n\n");
      if (!text.trim() || Buffer.byteLength(text) > 8192)
        throw Error(
          "InvalidMemory: accepted result exceeds saved-context limit",
        );
      const item = {
        id: randomUUID(),
        text,
        source: c.id,
        sourceProvenance: {
          conversationId: c.id,
          revision: c.revision,
          acceptedVersion: c.version,
          executionReceipts,
          instructions,
          bee: c.source ?? null,
          artifacts: artifacts.map((a) => ({
            id: a.id,
            revision: a.plan?.revision ?? a.revision ?? null,
            digest: hash(a.content),
          })),
        },
        purpose: "Explicitly saved accepted companion result",
        revision: 1,
        expiresAt: null,
        savedAt: new Date(clock()).toISOString(),
      };
      db.prepare("INSERT INTO memories VALUES(?,?,?)").run(
        item.id,
        owner,
        JSON.stringify(item),
      );
      return item;
    }
    if (action === "save") {
      const t = owned(owner, input.taskId);
      if (t.status !== "completed") throw Error("ReviewFirst");
      const item = {
        id: randomUUID(),
        text: t.text,
        source: t.id,
        purpose: "Explicitly saved accepted request",
        revision: 1,
        expiresAt: null,
        savedAt: new Date(clock()).toISOString(),
      };
      db.prepare("INSERT INTO memories VALUES(?,?,?)").run(
        item.id,
        owner,
        JSON.stringify(item),
      );
      return item;
    }
    if (action === "edit") {
      const row = db
        .prepare("SELECT data FROM memories WHERE id=? AND owner=?")
        .get(input.id, owner);
      if (!row) throw Error("Unauthorized");
      const m = JSON.parse(row.data);
      const expiresAt = Object.hasOwn(input, "expiresAt")
        ? input.expiresAt
        : (m.expiresAt ?? null);
      if (
        typeof input.text !== "string" ||
        !input.text.trim() ||
        Buffer.byteLength(input.text) > 8192
      )
        throw Error(
          "InvalidMemoryText: Enter saved context of at most 8192 bytes.",
        );
      if (
        expiresAt !== null &&
        (!Number.isFinite(expiresAt) || expiresAt <= clock())
      )
        throw Error(
          "InvalidMemoryExpiry: Choose a future date and time, or clear expiry.",
        );
      m.text = input.text;
      m.expiresAt = expiresAt;
      m.revision = (m.revision ?? 1) + 1;
      db.prepare("UPDATE memories SET data=? WHERE id=? AND owner=?").run(
        JSON.stringify(m),
        input.id,
        owner,
      );
      return m;
    }
    if (action === "delete") {
      const row = db
        .prepare("SELECT owner FROM memories WHERE id=?")
        .get(input.id);
      if (!row || row.owner !== owner) throw Error("Unauthorized");
      db.prepare("DELETE FROM memories WHERE id=? AND owner=?").run(
        input.id,
        owner,
      );
      return { deleted: true };
    }
    throw Error("UnsupportedCommand");
  });
  return {
    create,
    get,
    list,
    command,
    runNext,
    interpretNext,
    memory,
    close: () => {
      for (const c of controllers.values()) c.abort();
      db.close();
    },
  };
}

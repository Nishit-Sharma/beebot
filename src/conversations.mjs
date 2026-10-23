import { editorialContinuation } from "./editorial-continuation.mjs";
import {
  issuePendingQuestion,
  validateSelectedReply,
} from "./pending-question.mjs";
import {
  buildCompanionRequest,
  assertRequestGuidance,
} from "./proposal-request.mjs";
import {
  preparePrivateArtifacts,
  progressContext,
  providerEnvelope,
} from "./private-work.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  prepareGenerated,
  applyGenerated,
  bindOwnerChecks,
} from "./generated-policy.mjs";
import { runDemo, snapshot } from "./demo-runner.mjs";
import { hash } from "./demo-runner.mjs";
import { validateProposal, scopedPlan } from "./capabilities.mjs";
/** Persist first; provider output is untrusted proposals, never tool authority. */
export function createConversations({
  directory,
  clock = Date.now,
  memoryRead = () => null,
  // Disabled by default. A future transport must supply trusted selected-source reads.
  replySourceRead = null,
  onEvent = () => {},
  runSandbox = runDemo,
}) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "conversations.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,owner TEXT,data TEXT); CREATE TABLE IF NOT EXISTS commands(owner TEXT,id TEXT,digest TEXT,result TEXT,PRIMARY KEY(owner,id));",
  );
  const running = new Map();
  const save = (c) => {
    db.prepare(
      "INSERT INTO conversations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(c.id, c.owner, JSON.stringify(c));
    onEvent(c.id);
    return c;
  };
  const read = (owner, id) => {
    const row = db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    if (!row || row.owner !== owner) throw Error("Unauthorized");
    const c = JSON.parse(row.data);
    c.approvals ??= [];
    return c;
  };
  const event = (c, type, text) =>
    c.events.push({ sequence: c.events.length + 1, type, text, at: clock() });
  const clearAttemptError = (c) => {
    if (
      c.error &&
      !c.events.some((e) => e.type === "failure" && e.text === c.error)
    )
      event(c, "failure", c.error);
    delete c.error;
  };
  let restored;
  try {
    // Parse the complete set before recovery writes; an unreadable row must not
    // cause partial recovery or an automatic reset of other stored work.
    restored = db
      .prepare("SELECT data FROM conversations")
      .all()
      .map((row) => {
        const c = JSON.parse(row.data);
        if (
          !c ||
          typeof c.id !== "string" ||
          typeof c.owner !== "string" ||
          !Array.isArray(c.events) ||
          !Array.isArray(c.steps) ||
          !Array.isArray(c.memorySources) ||
          !Number.isFinite(c.revision) ||
          !Number.isFinite(c.version)
        )
          throw Error("InvalidStoredConversation");
        return c;
      });
  } catch {
    db.close();
    throw Error(
      "StoredConversationStateUnreadable: conversations.sqlite was kept unchanged. Stop the app and restore a known-good backup or seek recovery help; no automatic reset was performed.",
    );
  }
  for (const c of restored) {
    const revoked =
      c.status === "source_changed" ||
      c.events.some((e) => e.type === "revocation");
    const migrateRevocation = revoked && !c.sourceRevoked;
    if (revoked) c.sourceRevoked = true;
    if (["thinking", "acting", "pausing", "cancelling"].includes(c.status)) {
      c.status =
        c.status === "cancelling"
          ? "cancelled"
          : c.sourceRevoked
            ? "source_changed"
            : c.status === "pausing"
              ? "paused"
              : "interrupted";
      c.steps = c.steps.filter((s) => s.status === "completed");
      c.stream = "";
      c.revision++;
      c.version++;
      event(
        c,
        "recovery",
        "Outcome unknown after restart; unused plans revoked. Pause/cancel intent retained. Reconcile any attempted action and request a fresh proposal before continuing.",
      );
      save(c);
    } else if (migrateRevocation) {
      c.version++;
      save(c);
    }
  }
  const checkSource = (c) => {
    if (c.sourceRevoked || c.status === "source_changed")
      throw Error("SourceChangedStartNewConversation");
    const unavailable = c.memorySources.filter((source) => {
      const current = memoryRead(c.owner, source.id);
      return (
        !current ||
        hash(current.text) !== source.digest ||
        (current.revision ?? 1) !== source.revision ||
        (current.expiresAt && current.expiresAt <= clock())
      );
    });
    if (unavailable.length) {
      c.sourceRevoked = true;
      c.status = "source_changed";
      c.steps = [];
      c.stream = "";
      c.memorySources = c.memorySources.filter(
        (source) => !unavailable.some((item) => item.id === source.id),
      );
      c.version++;
      running.get(c.id)?.abort();
      event(
        c,
        "revocation",
        "Saved source expired, changed or became unavailable. Pending work revoked; historical messages, artifacts and audit evidence remain.",
      );
      save(c);
      throw Error("MemoryChanged");
    }
  };
  const memorySources = (owner, ids) =>
    ids.map((id) => {
      const m = memoryRead(owner, id);
      if (!m || (m.expiresAt && m.expiresAt <= clock()))
        throw Error("MemoryUnavailable");
      return {
        id,
        revision: m.revision ?? 1,
        digest: hash(m.text),
        text: m.text,
      };
    });
  const intentChanges = (c) => {
    const requests = c.messages.filter((m) => m.role === "user");
    return (c.intentChanges ?? [])
      .filter(
        (change) =>
          change.type === "replace-request" &&
          change.source === "owner-command" &&
          change.scope === "entire-message" &&
          change.actor === c.owner &&
          Number.isInteger(change.requestNumber) &&
          change.requestNumber >= 1 &&
          Number.isInteger(change.replacementRequestNumber) &&
          change.replacementRequestNumber > change.requestNumber &&
          change.replacementRequestNumber <= requests.length &&
          change.requestDigest ===
            hash(requests[change.requestNumber - 1]?.text),
      )
      .map(
        ({
          type,
          source,
          scope,
          requestNumber,
          replacementRequestNumber,
          requestDigest,
          actor,
          at,
        }) => ({
          type,
          source,
          scope,
          requestNumber,
          replacementRequestNumber,
          requestDigest,
          replacementRequestDigest: hash(
            requests[replacementRequestNumber - 1].text,
          ),
          actor,
          at,
        }),
      );
  };
  const providerInput = (c, messages = c.messages) => ({
    messages,
    memory: c.memorySources.map(({ id, text }) => ({ id, text })),
    artifacts: progressContext(c),
    intentChanges: intentChanges(c),
  });
  const checkContextBudget = (input) => buildCompanionRequest(input);
  const bindGuidance = (c, request) => {
    c.queuedGuidance = { revision: c.revision, ...request.provenance };
  };
  function create(
    owner,
    text,
    mode = "codex",
    memoryIds = [],
    fixtureKind = "workshop",
    source = null,
    taskId = null,
  ) {
    if (taskId !== null && !/^bee-[0-9a-f]{32}$/.test(taskId))
      throw Error("InvalidTaskIdentity");
    if (!["workshop", "policy"].includes(fixtureKind))
      throw Error("InvalidFixture");
    if (!["codex", "fixture"].includes(mode)) throw Error("InvalidProvider");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (taskId) {
        const existing = db
          .prepare("SELECT owner,data FROM conversations WHERE id=?")
          .get(taskId);
        if (existing) {
          if (existing.owner !== owner) throw Error("Unauthorized");
          db.exec("COMMIT");
          return JSON.parse(existing.data);
        }
      }
      const c = {
        id: taskId ?? randomUUID(),
        owner,
        version: 1,
        revision: 0,
        status: "ready",
        mode,
        fixtureKind,
        source,
        messages: [],
        steps: [],
        artifacts: [],
        events: [],
        memorySources: memorySources(owner, memoryIds),
        stream: "",
        createdAt: clock(),
      };
      save(c);
      const result = send(owner, c.id, text, 1);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function send(owner, id, text, version) {
    let c = read(owner, id);
    if (c.version !== version) throw Error("StaleRevision");
    checkSource(c);
    if (running.has(id) || c.status === "thinking") throw Error("WaitForTurn");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 8192 ||
      c.messages.length >= 40
    )
      throw Error("ConversationBudgetExceeded");
    const message = { role: "user", text, at: clock() };
    const request = checkContextBudget(
      providerInput(c, [...c.messages, message]),
    );
    if (c.pendingQuestion?.state === "pending")
      c.pendingQuestion.state = "superseded";
    c.messages.push(message);
    c.revision++;
    bindGuidance(c, request);
    c.version++;
    c.status = "queued";
    clearAttemptError(c);
    c.steps = [];
    c.stream = "";
    event(c, "request", "New instruction invalidates prior unconsumed plans.");
    return save(c);
  }
  function prepareDrafts(c) {
    preparePrivateArtifacts(c, { now: clock, id: randomUUID, hash, event });
  }
  async function run(owner, id, provider) {
    let c = read(owner, id);
    if (c.status !== "queued" || running.size) return c;
    const ctrl = new AbortController();
    running.set(id, ctrl);
    c.status = "thinking";
    c.version++;
    save(c);
    const revision = c.revision;
    try {
      checkSource(c);
      let input = providerInput(c);
      let request = checkContextBudget(input);
      if (
        c.queuedGuidance?.revision !== undefined &&
        c.queuedGuidance.revision !== c.revision
      )
        throw Error("GuidanceRequestRevisionMismatch");
      assertRequestGuidance(c.queuedGuidance, request);
      const propose = async () => {
        c = read(owner, id);
        if (
          c.status !== "thinking" ||
          c.revision !== revision ||
          ctrl.signal.aborted
        )
          return null;
        checkSource(c);
        bindGuidance(c, request);
        c.guidanceRequests ??= [];
        if (c.guidanceRequests.length >= 80)
          throw Error("GuidanceAttemptBudgetExceeded");
        c.guidanceRequests.push({
          ...structuredClone(c.queuedGuidance),
          mode: c.mode,
          at: clock(),
        });
        event(
          c,
          "guidance",
          "Proposal guidance prepared: " +
            request.provenance.modules
              .map((m) => m.id + "@" + m.version + "#" + m.sha256)
              .join(", ") +
            ". No capabilities granted.",
        );
        save(c);
        c.memorySources.forEach((s) => {
          const m = memoryRead(owner, s.id);
          if (
            !m ||
            hash(m.text) !== s.digest ||
            (m.expiresAt && m.expiresAt <= clock())
          )
            throw Error("MemoryChanged");
        });
        const result = validateProposal(
          await provider({
            fixtureKind: c.fixtureKind,
            ...input,
            requestGuidance: structuredClone(c.queuedGuidance),
            signal: ctrl.signal,
            onDelta: (delta) => {
              const current = read(owner, id);
              if (
                current.revision !== revision ||
                current.status !== "thinking"
              )
                return;
              checkSource(current);
              current.stream += String(delta);
              if (Buffer.byteLength(current.stream) > 16000) {
                ctrl.abort();
                throw Error("StreamBudgetExceeded");
              }
              save(current);
            },
          }),
        );
        c = read(owner, id);
        if (c.status !== "thinking" || c.revision !== revision) return null;
        checkSource(c);
        return result;
      };
      let result = await propose();
      if (!result) return c;
      const continuation = editorialContinuation(result, input);
      if (continuation) {
        event(
          c,
          "editorial-continuation",
          "A reversible editorial question was not sent back as an owner blocker. Preparing one bounded private revision with all original constraints retained. Proposed question: " +
            result.questions.join(" ").slice(0, 1000),
        );
        c.stream = "";
        save(c);
        input = { ...input, privatePreparationReview: continuation };
        request = checkContextBudget(input);
        result = await propose();
        if (!result) return c;
        if (editorialContinuation(result, input))
          throw Error(
            "PrivateDraftNotProduced: The provider repeated an editorial question instead of preparing the requested draft. No external action occurred; retry preparation.",
          );
      }
      c.messages.push({
        role: "assistant",
        text: result.reply,
        questions: result.questions,
        guidance: structuredClone(c.queuedGuidance),
        at: clock(),
      });
      c.steps = result.steps.map((s) =>
        scopedPlan(s, {
          conversationId: id,
          revision,
          guidance: c.queuedGuidance,
          memorySources: c.memorySources.map(({ id, revision, digest }) => ({
            id,
            revision,
            digest,
          })),
          expiresAt: clock() + 600000,
        }),
      );
      if (c.pendingQuestion) {
        c.questionHistory ??= [];
        c.questionHistory.push(c.pendingQuestion);
      }
      c.pendingQuestion = result.questions.length
        ? issuePendingQuestion(c, result.questions, clock())
        : null;
      prepareDrafts(c);
      c.status = result.questions.length
        ? "clarifying"
        : c.steps.length
          ? c.steps.every((s) => s.status === "completed")
            ? "review_required"
            : "plan_review"
          : "ready";
      c.stream = "";
      clearAttemptError(c);
      event(c, "proposal", "Proposal received; no actions executed.");
    } catch (e) {
      c = read(owner, id);
      if (c.status === "thinking") {
        if (c.sourceRevoked || e.message === "MemoryChanged") {
          c.sourceRevoked = true;
          c.steps = [];
          c.status = "source_changed";
        } else c.status = ctrl.signal.aborted ? "paused" : "failed";
        c.error = String(e.message ?? e).slice(0, 500);
        event(c, "failure", c.error);
      }
    } finally {
      running.delete(id);
      if (c.status === "pausing") c.status = "paused";
      if (c.status === "cancelling") c.status = "cancelled";
      c.version++;
      save(c);
    }
    return c;
  }
  function command(owner, id, input) {
    const c = read(owner, id);
    if (!input.id || typeof input.id !== "string" || input.id.length > 100)
      throw Error("InvalidCommand");
    const digest = hash({ conversationId: id, command: input });
    const prior = db
      .prepare("SELECT * FROM commands WHERE owner=? AND id=?")
      .get(owner, input.id);
    if (prior) {
      const result = JSON.parse(prior.result);
      // Retain exact replays from the previous fingerprint only for their original conversation.
      if (
        prior.digest !== digest &&
        !(result.id === id && prior.digest === hash({ id, ...input }))
      )
        throw Error("IdempotencyConflict");
      return result;
    }
    if (c.version !== input.version) throw Error("StaleRevision");
    if (input.type === "answer-question") {
      if (!replySourceRead) throw Error("SelectedBeeReplyTransportUnavailable");
      checkSource(c);
      const source = replySourceRead(owner, input.sourceId);
      const answer = validateSelectedReply(c, input, source, clock());
      const snapshot = memorySources(owner, [answer.memoryId])[0];
      if (
        snapshot.digest !== hash(answer.text) ||
        snapshot.revision !== source.revision
      )
        throw Error("SelectedBeeReplySourceChanged");
      if (c.memorySources.some((s) => s.id === snapshot.id))
        throw Error("SelectedBeeReplySourceAlreadyUsed");
      if (c.messages.length >= 40 || c.memorySources.length >= 10)
        throw Error("ConversationBudgetExceeded");
      const message = {
        role: "user",
        text: answer.text,
        at: clock(),
        beeReply: answer.provenance,
      };
      const request = checkContextBudget({
        ...providerInput(c, [...c.messages, message]),
        memory: [...c.memorySources, snapshot].map(({ id, text }) => ({
          id,
          text,
        })),
      });
      c.memorySources.push(snapshot);
      c.messages.push(message);
      c.pendingQuestion.state = "answered";
      c.pendingQuestion.answer = answer.provenance;
      c.revision++;
      bindGuidance(c, request);
      c.status = "queued";
      c.steps = [];
      c.stream = "";
      clearAttemptError(c);
      event(
        c,
        "selected-bee-answer",
        "Owner confirmed one selected recording as an answer to this exact pending question. Same task retained; prior constraints remain. No external delivery or execution authorized.",
      );
    } else if (input.type === "replace-request") {
      checkSource(c);
      const requests = c.messages.filter((m) => m.role === "user");
      if (
        !Number.isInteger(input.requestNumber) ||
        !Number.isInteger(input.replacementRequestNumber) ||
        input.requestNumber < 1 ||
        input.replacementRequestNumber <= input.requestNumber ||
        input.replacementRequestNumber > requests.length ||
        input.requestDigest !== hash(requests[input.requestNumber - 1]?.text)
      )
        throw Error("InvalidOwnerReplacement");
      c.intentChanges ??= [];
      c.intentChanges.push({
        type: "replace-request",
        source: "owner-command",
        scope: "entire-message",
        requestNumber: input.requestNumber,
        replacementRequestNumber: input.replacementRequestNumber,
        requestDigest: input.requestDigest,
        actor: owner,
        at: clock(),
      });
      checkContextBudget(providerInput(c));
      c.steps = [];
      c.stream = "";
      if (c.pendingQuestion?.state === "pending")
        c.pendingQuestion.state = "superseded";
      c.revision++;
      bindGuidance(c, checkContextBudget(providerInput(c)));
      c.status = "queued";
      clearAttemptError(c);
      running.get(id)?.abort();
      event(
        c,
        "owner-intent-change",
        "Owner explicitly recorded replacement of exact request " +
          input.requestNumber +
          " by request " +
          input.replacementRequestNumber +
          ". Other context is retained.",
      );
    } else if (input.type === "checklist-item") {
      const artifact = c.artifacts.find(
        (a) =>
          a.id === input.artifactId && a.verification?.kind === "checklist",
      );
      if (
        !artifact ||
        !artifact.verification.data.items.some(
          (item) => item.id === input.itemId,
        ) ||
        typeof input.done !== "boolean"
      )
        throw Error("InvalidProgressCommand");
      artifact.progress ??= {};
      artifact.progress[input.itemId] = {
        done: input.done,
        by: owner,
        at: clock(),
      };
      event(
        c,
        "owner-progress",
        "Owner marked checklist item " +
          input.itemId +
          " " +
          (input.done ? "done" : "unfinished") +
          ". This is owner-reported progress, not independently verified execution.",
      );
    } else if (input.type === "pause" || input.type === "cancel") {
      if (["completed", "cancelled"].includes(c.status))
        throw Error("ConversationClosed");
      if (input.type === "pause") checkSource(c);
      if (c.pendingQuestion?.state === "pending")
        c.pendingQuestion.state = "revoked";
      c.status = running.has(id)
        ? input.type === "pause"
          ? "pausing"
          : "cancelling"
        : input.type === "pause"
          ? "paused"
          : "cancelled";
      c.steps = [];
      running.get(id)?.abort();
      event(
        c,
        input.type,
        "Unused approvals revoked; provider interruption requested.",
      );
    } else if (input.type === "resume") {
      checkSource(c);
      if (c.status !== "paused" || running.has(id)) throw Error("WaitForPause");
      checkContextBudget(providerInput(c));
      c.status = "queued";
      clearAttemptError(c);
      c.revision++;
      bindGuidance(c, checkContextBudget(providerInput(c)));
      c.stream = "";
      c.steps = [];
      event(
        c,
        "resume",
        "Resume requests a fresh proposal. Prior plans stay revoked.",
      );
    } else if (input.type === "accept") {
      checkSource(c);
      if (c.status !== "review_required") throw Error("ReviewFirst");
      c.status = "completed";
      event(c, "review", "User accepted the local artifacts.");
    } else if (input.type === "approve") {
      checkSource(c);
      if (running.has(id) || c.status === "action_queued")
        throw Error("WaitForCurrentAction");
      if (c.status !== "plan_review") throw Error("ApprovalMismatch");
      const step = c.steps.find((s) => s.digest === input.digest);
      if (
        !step ||
        step.status !== "approval_required" ||
        step.revision !== c.revision ||
        step.expiresAt <= clock()
      )
        throw Error("ApprovalMismatch");
      for (const s of step.memorySources) {
        const m = memoryRead(owner, s.id);
        if (
          !m ||
          hash(m.text) !== s.digest ||
          (m.expiresAt && m.expiresAt <= clock())
        )
          throw Error("MemoryChanged");
      }
      if (
        step.dependsOn.some(
          (d) => !c.steps.some((s) => s.id === d && s.status === "completed"),
        )
      )
        throw Error("DependencyPending");
      if (step.capability === "demo.policy" && step.stage === "test") {
        const proposedCaseDigest = hash(step.recipe.cases);
        step.recipe = bindOwnerChecks(step.recipe, input.acceptanceCases ?? []);
        step.acceptance = {
          condition: c.messages.filter((m) => m.role === "user").at(-1)?.text,
          proposedCaseDigest,
          additionalCases: structuredClone(input.acceptanceCases ?? []),
          confirmedBy: owner,
          at: clock(),
        };
        step.approvalBindingDigest = hash({
          proposalDigest: step.digest,
          acceptance: step.acceptance,
        });
      }
      c.approvals.push({
        plan: structuredClone(step),
        actor: owner,
        at: clock(),
        decision: "approved",
      });
      if (step.capability === "demo.policy") {
        step.status = "queued";
        c.status = "action_queued";
        event(
          c,
          "approval",
          "Approved exact " +
            step.stage +
            " plan. Queued for isolated execution.",
        );
      } else {
        if (step.capability !== "local.document")
          throw Error("CapabilityUnavailable");
        const artifact = {
          id: randomUUID(),
          stepId: step.id,
          title: step.title,
          content: step.content,
          digest: hash(step.content),
          plan: structuredClone(step),
          approvedBy: owner,
          at: clock(),
        };
        c.artifacts.push(artifact);
        step.status = "completed";
        step.receipt = { artifactId: artifact.id, digest: artifact.digest };
        event(
          c,
          "result",
          "Approved exact document saved locally. No external send.",
        );
        if (c.steps.every((s) => s.status === "completed"))
          c.status = "review_required";
      }
    } else throw Error("UnsupportedCommand");
    c.version++;
    db.exec("BEGIN IMMEDIATE");
    try {
      save(c);
      db.prepare("INSERT INTO commands VALUES(?,?,?,?)").run(
        owner,
        input.id,
        digest,
        JSON.stringify(c),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return c;
  }
  async function runAction(owner, id) {
    let c = read(owner, id);
    if (c.status !== "action_queued" || running.size) return c;
    if (c.sourceRevoked) {
      c.status = "source_changed";
      c.steps = [];
      c.version++;
      return save(c);
    }
    const step = c.steps.find((s) => s.status === "queued");
    if (!step) throw Error("MissingAction");
    try {
      checkSource(c);
    } catch (error) {
      if (c.sourceRevoked) return c;
      throw error;
    }
    if (step.expiresAt <= clock()) {
      c.status = "failed";
      c.error = "ApprovalExpired";
      step.status = "failed";
      step.error = actionError("ApprovalExpired");
      c.version++;
      return save(c);
    }
    const ctrl = new AbortController();
    running.set(id, ctrl);
    const revision = c.revision;
    const directoryPath = join(
      directory,
      "generated-workspaces",
      id,
      ...(step.workspaceVersion === 2 ? ["revision-" + revision] : []),
      step.id,
    );
    c.status = "acting";
    step.status = "running";
    c.version++;
    event(
      c,
      "attempt",
      "Approved isolated " + step.stage + " attempt started.",
    );
    save(c);
    try {
      if (step.stage === "test") prepareGenerated(directoryPath, step.recipe);
      else applyGenerated(directoryPath, step.recipe, step.sourceHash);
      const evidence = await runSandbox(directoryPath, { signal: ctrl.signal });
      c = read(owner, id);
      c.actionEvidence ??= [];
      c.actionEvidence.push({
        ...evidence,
        stepId: step.id,
        stage: step.stage,
        revision,
      });
      if (c.status !== "acting" || c.revision !== revision) return c;
      checkSource(c);
      const current = c.steps.find((s) => s.id === step.id);
      current.evidence ??= [];
      current.evidence.push(evidence);
      if (evidence.exitCode === 0) {
        clearAttemptError(c);
        current.status = "completed";
        current.receipt = {
          sourceHash: evidence.sourceHash,
          outputHash: evidence.outputHash,
        };
        prepareDrafts(c);
        c.status = c.steps.every((s) => s.status === "completed")
          ? "review_required"
          : "plan_review";
        event(
          c,
          "result",
          "Confirmed cases passed in the macOS sandbox. Human review required.",
        );
      } else if (step.stage === "test") {
        current.stage = "patch";
        current.status = "approval_required";
        current.sourceHash = snapshot(directoryPath);
        current.expiresAt = clock() + 600000;
        current.digest = hash({ ...current, digest: undefined });
        c.status = "plan_review";
        event(
          c,
          "proposal",
          "Baseline failed. Generated exact patch requires a new approval.",
        );
      } else {
        current.status = "failed";
        c.status = "failed";
        c.error = "Generated patch did not pass its cases";
        event(c, "failure", c.error);
      }
    } catch (e) {
      c = read(owner, id);
      if (c.status === "acting") {
        c.status = ctrl.signal.aborted ? "paused" : "failed";
        c.error = actionError(e.message ?? e);
        event(c, "failure", c.error);
        const failedStep = c.steps.find((s) => s.id === step.id);
        if (failedStep) {
          failedStep.status = ctrl.signal.aborted ? "paused" : "failed";
          failedStep.error = c.error;
        }
      }
    } finally {
      running.delete(id);
      if (c.status === "pausing") c.status = "paused";
      if (c.status === "cancelling") c.status = "cancelled";
      c.version++;
      save(c);
    }
    return c;
  }
  function revokeMemory(owner, memoryId) {
    for (const row of db
      .prepare("SELECT data FROM conversations WHERE owner=?")
      .all(owner)) {
      const c = JSON.parse(row.data);
      if (c.memorySources.some((s) => s.id === memoryId)) {
        c.steps = [];
        c.status = "source_changed";
        c.sourceRevoked = true;
        c.version++;
        c.memorySources = c.memorySources.filter((s) => s.id !== memoryId);
        running.get(c.id)?.abort();
        event(
          c,
          "revocation",
          "Saved source changed or removed. Pending plans and source snapshots revoked; historical messages, artifacts and audit evidence remain.",
        );
        save(c);
      }
    }
  }
  function waitForSource(owner, id, action = false) {
    const c = read(owner, id);
    if (!["queued", "action_queued"].includes(c.status)) return c;
    c.status = action ? "waiting_source_action" : "waiting_source";
    c.version++;
    event(
      c,
      "source-wait",
      "Waiting for a fresh selected Bee source before model input or execution. No cached-source action was started.",
    );
    return save(c);
  }
  function sourceAvailable(owner, sourceId) {
    for (const row of db
      .prepare("SELECT data FROM conversations WHERE owner=?")
      .all(owner)) {
      const c = JSON.parse(row.data);
      if (
        c.source?.id !== sourceId ||
        c.sourceRevoked ||
        !["waiting_source", "waiting_source_action"].includes(c.status)
      )
        continue;
      // A transport outage may temporarily make selected Bee context unreadable.
      // Keep waiting instead of treating missing refresh data as a deletion event.
      if (
        c.memorySources.some((source) => {
          const current = memoryRead(owner, source.id);
          return (
            source.id.startsWith("bee:") &&
            (!current || hash(current.text) !== source.digest)
          );
        })
      )
        continue;
      try {
        checkSource(c);
        checkContextBudget(providerInput(c));
      } catch (error) {
        if (c.sourceRevoked) continue;
        c.status = "failed";
        c.error = String(error.message).slice(0, 500);
        c.version++;
        event(c, "failure", c.error);
        save(c);
        continue;
      }
      c.status =
        c.status === "waiting_source_action" ? "action_queued" : "queued";
      c.version++;
      event(
        c,
        "source-ready",
        "Fresh selected source verified; durable work can continue without a new prompt.",
      );
      save(c);
    }
  }
  function cancelSource(owner, sourceId) {
    for (const row of db
      .prepare("SELECT data FROM conversations WHERE owner=?")
      .all(owner)) {
      const c = JSON.parse(row.data);
      if (
        c.source?.id === sourceId &&
        !["cancelled", "cancelling", "completed"].includes(c.status)
      )
        command(owner, c.id, {
          id: randomUUID(),
          version: c.version,
          type: "cancel",
        });
    }
  }
  return {
    create,
    send,
    run,
    runAction,
    command,
    cancelSource,
    waitForSource,
    sourceAvailable,
    revokeMemory,
    get: read,
    list: (owner) =>
      db
        .prepare(
          "SELECT data FROM conversations WHERE owner=? ORDER BY rowid DESC",
        )
        .all(owner)
        .map((r) => JSON.parse(r.data)),
    close: () => {
      for (const c of running.values()) c.abort();
      db.close();
    },
  };
}

export function actionError(error) {
  const text = String(error);
  if (/ENOENT.*sandbox-exec|sandbox-exec.*ENOENT/.test(text))
    return "The macOS sandbox isn't available on this machine.";
  return (
    {
      ApprovalExpired: "That approval expired; ask for a fresh plan.",
      SandboxUnavailable: "The sandbox couldn't run the test.",
      BeeSourceChanged:
        "Bee updated this conversation; review the new version.",
    }[text] ?? text.slice(0, 500)
  );
}

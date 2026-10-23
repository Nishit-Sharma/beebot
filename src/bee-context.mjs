import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createHash } from "node:crypto";
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
/** Bee context is persisted evidence, never an instruction or an authorization. */
export function createBeeContext({ directory, onRevoke = () => {} }) {
  const db = new DatabaseSync(join(directory, "bee-context.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS claims(source TEXT PRIMARY KEY,conversation TEXT); CREATE TABLE IF NOT EXISTS follows(source TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS reservations(source TEXT PRIMARY KEY,conversation TEXT NOT NULL,state TEXT NOT NULL,intent TEXT NOT NULL);",
  );
  const get = (id) => {
    const row = db.prepare("SELECT data FROM sources WHERE id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const save = (s) => {
    db.prepare(
      "INSERT INTO sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(s.id, JSON.stringify(s));
    return s;
  };
  function ingest({
    reference,
    text,
    kind = "conversation",
    transport = "mcp",
    simulated = false,
    recovered = false,
    conversationId = null,
    conversationUuid = null,
    transcriptDigest = null,
    discovered = false,
  }) {
    if (
      typeof reference !== "string" ||
      !reference ||
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 32000 ||
      ![
        "conversation",
        "voice-note",
        "todo",
        "context-result",
        "utterance",
      ].includes(kind)
    )
      throw Error("InvalidBeeContext");
    const id = digest({ reference, simulated }).slice(0, 32),
      prior = get(id),
      contentHash = transcriptDigest ?? digest(text);
    if (
      prior &&
      !prior.deleted &&
      prior.digest === contentHash &&
      (prior.conversationId ?? null) === conversationId &&
      (prior.conversationUuid ?? null) === conversationUuid
    ) {
      if (prior.text !== text)
        return save({
          ...prior,
          text,
          contextDigest: digest(text),
          approvedText: prior.approvedText,
          metadataUpdated: true,
        });
      return prior;
    }
    const s = {
      id,
      reference,
      text,
      kind,
      conversationId,
      conversationUuid,
      transport,
      simulated,
      recovered,
      authorized: false,
      discovered,
      revision: (prior?.revision ?? 0) + 1,
      digest: contentHash,
      contextDigest: digest(text),
      receivedAt: new Date().toISOString(),
      deleted: false,
    };
    if (prior) onRevoke("bee:" + id);
    return save(s);
  }
  function removeConversation(conversationId, conversationUuid) {
    for (const row of db.prepare("SELECT data FROM sources").all()) {
      const source = JSON.parse(row.data);
      if (
        !source.deleted &&
        (source.conversationId === String(conversationId) ||
          (conversationUuid && source.conversationUuid === conversationUuid) ||
          source.reference === "conversation:" + conversationId)
      )
        remove(source.id);
    }
  }
  function remove(id) {
    const s = get(id);
    if (!s) throw Error("SourceUnavailable");
    s.deleted = true;
    s.text = "";
    delete s.approvedText;
    s.revision++;
    db.exec("BEGIN IMMEDIATE");
    try {
      save(s);
      db.prepare("DELETE FROM follows WHERE source=?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    onRevoke("bee:" + id);
    return {
      ...s,
      deletionSemantics:
        "Source text cleared and pending work revoked. Historical messages, approved artifacts and audit evidence remain; this is not full-history erasure.",
    };
  }
  function memory(id) {
    const s = id.startsWith("bee:") ? get(id.slice(4)) : null;
    return s && !s.deleted
      ? { id, text: s.approvedText ?? s.text, revision: s.revision }
      : null;
  }
  function claim(id, version, make, intent = {}) {
    const s = get(id);
    if (!s || s.deleted || s.revision !== version) throw Error("SourceChanged");
    if (
      intent.contextDigest &&
      intent.contextDigest !== (s.contextDigest ?? digest(s.text))
    )
      throw Error("SourceContextChanged");
    if (
      Object.hasOwn(intent, "goal") &&
      (typeof intent.goal !== "string" ||
        !intent.goal.trim() ||
        Buffer.byteLength(intent.goal) > 8192)
    )
      throw Error("ConversationBudgetExceeded");
    if (!s.approvedText) {
      s.approvedText = s.text;
      save(s);
    }
    const key = id + ":" + version;
    const old = db
      .prepare("SELECT conversation FROM claims WHERE source=?")
      .get(key);
    if (old) return { conversationId: old.conversation, duplicate: true };
    let row = db.prepare("SELECT * FROM reservations WHERE source=?").get(key);
    const duplicate = !!row;
    if (!row) {
      const conversation =
        "bee-" + digest({ source: id, revision: version }).slice(0, 32);
      db.prepare("INSERT INTO reservations VALUES(?,?,?,?)").run(
        key,
        conversation,
        "reserved",
        JSON.stringify(intent),
      );
      row = db.prepare("SELECT * FROM reservations WHERE source=?").get(key);
    }
    if (intent.goal && JSON.parse(row.intent).goal !== intent.goal) {
      const error = Error(
        row.state === "ready"
          ? "SourceAlreadyClaimedWithDifferentIntent"
          : "SourceReservedWithDifferentIntent: Retry the original request or start a new task; the changed request was not submitted.",
      );
      if (row.state === "ready")
        error.existingConversationId = row.conversation;
      throw error;
    }
    if (row.state === "ready")
      return { conversationId: row.conversation, duplicate: true };
    const conversationId = make(s, row.conversation, JSON.parse(row.intent));
    if (conversationId !== row.conversation)
      throw Error("DeterministicTaskIdentityRequired");
    db.prepare("UPDATE reservations SET state=? WHERE source=?").run(
      "ready",
      key,
    );
    if (s.claimRecoveryError) {
      delete s.claimRecoveryError;
      save(s);
    }
    return { conversationId, duplicate };
  }
  function reconcileClaims(make) {
    const results = [];
    for (const row of db
      .prepare("SELECT source,intent FROM reservations WHERE state=?")
      .all("reserved")) {
      const [id, version] = row.source.split(":");
      const source = get(id);
      if (source && !source.deleted && source.revision === Number(version)) {
        try {
          results.push(
            claim(id, Number(version), make, JSON.parse(row.intent)),
          );
        } catch {
          // A bad request must not prevent startup or restoration of other tasks.
          // Preserve the original intent for inspection; never silently replace it.
          db.prepare("UPDATE reservations SET state=? WHERE source=?").run(
            "failed",
            row.source,
          );
          source.claimRecoveryError = {
            code: "ClaimRecoveryFailed",
            message:
              "This saved request could not be restored. Its source and history were kept. Retry the original request or start a new task.",
          };
          save(source);
          results.push({ sourceId: id, error: "ClaimRecoveryFailed" });
        }
      } else
        db.prepare("UPDATE reservations SET state=? WHERE source=?").run(
          "revoked",
          row.source,
        );
    }
    return results;
  }
  function follow(id, goal, mode) {
    const s = get(id);
    if (!s || s.deleted || typeof goal !== "string" || goal.length > 2000)
      throw Error("InvalidFollowScope");
    const old = db.prepare("SELECT data FROM follows WHERE source=?").get(id);
    const prior = old ? JSON.parse(old.data) : null;
    const instructions = prior?.instructions ?? [goal];
    if (prior && prior.goal !== goal) instructions.push(goal);
    const scope = {
      source: id,
      goal: prior?.goal ?? goal,
      instructions,
      durableContext: prior?.durableContext ?? null,
      mode,
      maxProposals: 6,
      proposalsCreated: 0,
      pausedReason: null,
      lastRevision: s.revision,
      expiresAt: Date.now() + 86400000,
      authority: "prepare-proposals-only",
      destination:
        mode === "fixture" ? "local-fixture" : "OpenAI/Codex GPT-6 Luna",
    };
    if (JSON.stringify(instructions).length > 6000)
      scope.pausedReason = "IntentContextBudgetReached";
    db.prepare(
      "INSERT INTO follows VALUES(?,?) ON CONFLICT(source) DO UPDATE SET data=excluded.data",
    ).run(id, JSON.stringify(scope));
    return scope;
  }
  function followStates() {
    return db
      .prepare("SELECT data FROM follows")
      .all()
      .map((r) => JSON.parse(r.data))
      .filter((s) => {
        const source = get(s.source);
        return s.expiresAt > Date.now() && source && !source.deleted;
      });
  }
  function scopes() {
    return followStates().filter((s) => !s.pausedReason);
  }
  function updateFollow(id, { instruction, context, pausedReason } = {}) {
    const row = db.prepare("SELECT data FROM follows WHERE source=?").get(id);
    if (!row) return;
    const scope = JSON.parse(row.data);
    scope.instructions ??= [scope.goal];
    if (instruction) {
      scope.instructions.push(instruction);
      if (JSON.stringify(scope.instructions).length > 6000)
        scope.pausedReason = "IntentContextBudgetReached";
    }
    if (context !== undefined) scope.durableContext = context;
    if (
      pausedReason !== undefined &&
      scope.pausedReason !== "IntentContextBudgetReached"
    ) {
      scope.pausedReason =
        pausedReason === null &&
        (scope.proposalsCreated ?? 0) >= (scope.maxProposals ?? 6)
          ? "ProposalBudgetReached"
          : pausedReason;
    }
    acknowledge(scope);
    return scope;
  }
  function stopFollow(id) {
    db.prepare("DELETE FROM follows WHERE source=?").run(id);
  }
  function acknowledge(scope) {
    db.prepare("UPDATE follows SET data=? WHERE source=?").run(
      JSON.stringify(scope),
      scope.source,
    );
  }
  return {
    ingest,
    get,
    remove,
    removeConversation,
    memory,
    claim,
    reconcileClaims,
    follow,
    scopes,
    followStates,
    updateFollow,
    stopFollow,
    acknowledge,
    list: ({ includeDeleted = false } = {}) =>
      db
        .prepare("SELECT data FROM sources ORDER BY rowid DESC")
        .all()
        .map((r) => JSON.parse(r.data))
        .filter((s) => includeDeleted || !s.deleted),
    close: () => db.close(),
  };
}
export function changedCursor(payload) {
  if (!payload || typeof payload.meta?.next_cursor !== "string")
    throw Error("InvalidBeeCursor");
  return payload.meta.next_cursor;
}
export const beePolicyFixture = {
  reference: "fixture:bee-discount-conversation",
  text: "Give cart totals of 100 or more a 10% discount. Totals below 100 should stay unchanged.",
  kind: "conversation",
  transport: "fixture-replay",
  simulated: true,
  recovered: false,
};

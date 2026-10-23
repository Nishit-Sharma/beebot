import {
  allowedHost,
  allowedOrigin,
  createProviderStatusCache,
  readJsonBody,
  httpErrorStatus,
} from "./http-boundaries.mjs";
import { discoverBeeConversations } from "./bee-discovery.mjs";
import { createBackgroundSupervisor } from "./background-supervisor.mjs";
import { progressContext } from "./private-work.mjs";
import { taskCoverage } from "./task-coverage.mjs";
import { createBeeInboxBridge } from "./bee-inbox-bridge.mjs";
import { createBeeSourceClient } from "./bee-client.mjs";
import { createBeeContext, beePolicyFixture } from "./bee-context.mjs";
import { createBeeMcp } from "./bee-mcp.mjs";
import { createConversations } from "./conversations.mjs";
import { capabilities } from "./capabilities.mjs";
import { fixtureCompanion } from "./fixture-companion.mjs";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { createHarness } from "./harness.mjs";
import { createCodexProvider } from "./codex-provider.mjs";
const directory = resolve(process.env.BEE_COMPANION_DATA ?? ".local");
const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const h = createHarness({ directory });
const provider = createCodexProvider({ directory });
const providerStatus = createProviderStatusCache({ provider });
const owner = "local-owner";
const csrf = randomBytes(32).toString("hex"),
  session = randomBytes(32).toString("hex");
const captures = [];
let conversations;
const inbox = createBeeContext({
  directory,
  onRevoke: (id) => conversations?.revokeMemory(owner, id),
});
const mcp = createBeeMcp();
const bee = createBeeSourceClient({
  selectedConversations: () =>
    inbox
      .scopes()
      .map((scope) => inbox.get(scope.source))
      .filter((source) => source && !source.simulated),
  onDelete: (identity) => {
    inbox.removeConversation(
      identity.conversationId,
      identity.conversationUuid,
    );
    for (let i = captures.length - 1; i >= 0; i--)
      if (
        captures[i].conversationId === identity.conversationId ||
        captures[i].providerReference === identity.conversationUuid
      )
        captures.splice(i, 1);
    stopStreamIfUnscoped();
  },
  onCapture: async (c) => {
    // Refresh only the followed numeric parent. Processing failures retry on poll.
    try {
      const source = await beeBridge.capture(c);
      captures.unshift({ ...c, sourceId: source.id });
      captures.splice(50);
    } catch {
      /* A live utterance is not a completed selectable source. */
    }
  },
});
const beeBridge = createBeeInboxBridge({ bee, inbox });
const run = Effect.runPromise;
const port = Number(process.env.BEE_COMPANION_PORT ?? 8767);
const origin = "http://127.0.0.1:" + port;
const files = {
  "/setup": "setup.html",
  "/setup.css": "setup.css",
  "/": "index.html",
  "/app.mjs": "app.mjs",
  "/visuals.mjs": "visuals.mjs",
  "/style.css": "style.css",
  "/beebot.svg": "beebot.svg",
};
const contentTypes = {
  html: "text/html; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};
function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
const eventClients = new Set();
conversations = createConversations({
  directory,
  memoryRead: (owner, id) =>
    inbox.memory(id) ??
    Effect.runSync(h.memory(owner, "list")).find((m) => m.id === id),
  onEvent: (id) => {
    for (const res of eventClients)
      res.write("data: " + JSON.stringify({ conversationId: id }) + "\n\n");
  },
});
let draining = false;
async function launch() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const conversation = conversations
        .list(owner)
        .toReversed()
        .find((c) => ["queued", "action_queued"].includes(c.status));
      if (conversation) {
        if (conversation.status === "action_queued") {
          try {
            await revalidate(conversation);
            await conversations.runAction(owner, conversation.id);
          } catch {
            const current = conversations.get(owner, conversation.id);
            if (current.status === "action_queued")
              conversations.waitForSource(owner, current.id, true);
          }
          continue;
        }
        try {
          await revalidate(conversation);
        } catch {
          if (conversations.get(owner, conversation.id).status === "queued")
            conversations.waitForSource(owner, conversation.id);
          continue;
        }
        await conversations.run(
          owner,
          conversation.id,
          conversation.mode === "fixture"
            ? fixtureCompanion
            : provider.converse,
        );
        continue;
      }
      const next = (await run(h.list(owner)))
        .toReversed()
        .find((t) => ["queued", "interpretation_queued"].includes(t.status));
      if (!next) break;
      if (next.status === "interpretation_queued")
        await run(h.interpretNext(next.id, provider.interpret));
      else await run(h.runNext(next.id));
    }
  } catch (e) {
    console.error("Worker error:", String(e).slice(0, 180));
  } finally {
    draining = false;
  }
}
function stopStreamIfUnscoped() {
  if (
    bee.status().started &&
    !inbox.scopes().some((scope) => {
      const source = inbox.get(scope.source);
      return (
        source &&
        !source.simulated &&
        source.conversationId &&
        source.conversationUuid
      );
    })
  )
    bee.stop();
}
async function revalidate(c) {
  if (!c.source || c.source.simulated) return;
  const source = inbox.get(c.source.id);
  if (!source || source.deleted) throw Error("BeeSourceUnavailable");
  if (source.transport === "manual-recovery") return;
  const match = /^conversation:(\d+)$/.exec(source.reference);
  if (!match) throw Error("BeeSourceNeedsFreshRead");
  const fresh = inbox.ingest(await bee.readConversation(match[1]));
  if (fresh.digest !== c.source.digest) throw Error("BeeSourceChanged");
}
function taskFromSource(source, taskId, intent) {
  return conversations.create(
    owner,
    intent.goal +
      (intent.durableContext
        ? "\n\nSaved owner-reported progress: " +
          JSON.stringify(intent.durableContext)
        : ""),
    source.simulated ? "fixture" : "codex",
    ["bee:" + source.id],
    source.simulated ? "policy" : "workshop",
    {
      id: source.id,
      reference: source.reference,
      revision: source.revision,
      transport: source.transport,
      simulated: source.simulated,
      recovered: source.recovered,
      digest: source.digest,
    },
    taskId,
  ).id;
}
function followUpdates() {
  for (const scope of inbox.scopes()) {
    const source = inbox.get(scope.source);
    if (!source || source.deleted || source.revision === scope.lastRevision)
      continue;
    try {
      inbox.claim(source.id, source.revision, taskFromSource, {
        goal: (scope.instructions ?? [scope.goal]).join(
          "\n\nOwner follow-up: ",
        ),
        durableContext: scope.durableContext,
      });
      scope.lastRevision = source.revision;
      scope.proposalsCreated = (scope.proposalsCreated ?? 0) + 1;
      if (scope.proposalsCreated >= (scope.maxProposals ?? 6))
        scope.pausedReason = "ProposalBudgetReached";
      inbox.acknowledge(scope);
    } catch (error) {
      inbox.updateFollow(scope.source, {
        pausedReason:
          "FollowNeedsReview: " + String(error.message).slice(0, 100),
      });
    }
  }
  stopStreamIfUnscoped();
  setImmediate(launch);
}

let pollOffset = 0;
const supervisor = createBackgroundSupervisor({
  directory,
  stream: bee,
  canStream: () =>
    inbox.scopes().some((scope) => {
      const s = inbox.get(scope.source);
      return s && !s.simulated && s.conversationId && s.conversationUuid;
    }),
  poll: async ({ discoveryEnabled }) => {
    const discovery = discoveryEnabled
      ? await discoverBeeConversations({ bee, inbox })
      : { added: 0, pending: 0 };
    const ids = new Set(inbox.scopes().map((scope) => scope.source));
    for (const c of conversations.list(owner))
      if (
        ["waiting_source", "waiting_source_action"].includes(c.status) &&
        c.source
      )
        ids.add(c.source.id);
    const sources = [...ids]
      .map((id) => inbox.get(id))
      .filter((s) => s && !s.simulated && !s.deleted);
    const selected = sources.length
      ? Array.from(
          { length: Math.min(4, sources.length) },
          (_, i) => sources[(pollOffset + i) % sources.length],
        )
      : [];
    pollOffset += selected.length;
    let failed = 0,
      refreshed = 0;
    for (const source of selected) {
      const match = /^conversation:(\d+)$/.exec(source.reference);
      if (match)
        try {
          const fresh = inbox.ingest(await bee.readConversation(match[1]));
          conversations.sourceAvailable(owner, fresh.id);
          refreshed++;
        } catch {
          failed++;
        }
    }
    followUpdates();
    return { attempted: selected.length, refreshed, failed, discovery };
  },
  drain: () => {
    setImmediate(launch);
  },
});
const followTimer = setInterval(() => supervisor.tick().catch(() => {}), 1000);
followTimer.unref();

const server = createServer(async (req, res) => {
  try {
    if (!allowedHost(req.headers.host, port))
      return json(res, 403, { error: "HostDenied" });
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    const url = new URL(req.url, origin);
    if (files[url.pathname] && req.method === "GET") {
      if (url.pathname === "/")
        res.setHeader(
          "set-cookie",
          "bee_session=" + session + "; HttpOnly; SameSite=Strict; Path=/",
        );
      const file = files[url.pathname];
      res.writeHead(200, {
        "content-type": contentTypes[file.split(".").at(-1)],
        "cache-control": "no-store",
      });
      return res.end(readFileSync(join(publicRoot, file)));
    }
    if (!req.headers.cookie?.split("; ").includes("bee_session=" + session))
      return json(res, 401, { error: "OpenLocalAppFirst" });
    if (
      req.method === "POST" &&
      (!allowedOrigin(req.headers.origin, req.headers.host, port) ||
        req.headers["x-bee-csrf"] !== csrf)
    )
      return json(res, 403, { error: "OriginOrCsrfDenied" });
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("data: {}\n\n");
      eventClients.add(res);
      req.on("close", () => eventClients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/snapshot")
      return json(res, 200, {
        csrf,
        conversations: conversations.list(owner),
        coverage: taskCoverage(conversations.list(owner)),
        capabilities,
        tasks: await run(h.list(owner)),
        memories: await run(h.memory(owner, "list")),
        bee: bee.status(),
        beeMcp: mcp.status(),
        sources: inbox.list(),
        follows: inbox.followStates(),
        captures,
        provider: await providerStatus(),
        worker: {
          location: "this Mac",
          online: Date.now() - (supervisor.status().lastTickAt ?? 0) < 5000,
          supervision: supervisor.status(),
        },
        limits: { attempts: 3, testSeconds: 15, outputKiB: 64 },
      });
    if (req.method !== "POST") return json(res, 404, { error: "NotFound" });
    const input = await readJsonBody(req);
    if (url.pathname === "/api/bee/context") {
      if (input.action === "recover")
        return json(
          res,
          200,
          inbox.ingest({
            reference: "recovered:" + randomBytes(16).toString("hex"),
            text: input.text,
            kind: "context-result",
            transport: "manual-recovery",
            recovered: true,
            simulated: false,
          }),
        );
      if (input.action === "capture") {
        const capture = captures.find((c) => c.id === input.captureId);
        const source = capture && inbox.get(capture.sourceId);
        if (!source || source.deleted) throw Error("CaptureUnavailable");
        return json(res, 200, source);
      }
      if (input.action === "replay")
        return json(res, 200, inbox.ingest(beePolicyFixture));
      if (input.action === "connect")
        return json(res, 200, await mcp.connect());
      if (input.action === "list-recent")
        return json(res, 200, {
          conversations: await bee.listRecentConversations(),
        });
      if (input.action === "read") {
        const source = inbox.ingest(
          await bee.readConversation(input.conversationId),
        );
        conversations.sourceAvailable(owner, source.id);
        followUpdates();
        return json(res, 200, source);
      }
      if (input.action === "stop-follow") {
        inbox.stopFollow(input.id);
        stopStreamIfUnscoped();
        return json(res, 200, { stopped: true });
      }
      if (input.action === "delete") {
        const removed = inbox.remove(input.id);
        stopStreamIfUnscoped();
        return json(res, 200, removed);
      }
      if (input.action === "select") {
        const selectedSource = inbox.get(input.id);
        if (
          selectedSource &&
          !selectedSource.simulated &&
          input.providerConsent !== "codex-openai"
        )
          throw Error("SelectedBeeContextProviderConsentRequired");
        if (
          input.confirmed !== true ||
          typeof input.goal !== "string" ||
          !input.goal.trim()
        )
          throw Error("ExplicitRequestRequired");
        if (
          selectedSource &&
          !selectedSource.simulated &&
          input.contextDigest !== selectedSource.contextDigest
        )
          throw Error("SourceContextChanged");
        const result = inbox.claim(input.id, input.revision, taskFromSource, {
          goal: input.goal,
          contextDigest: input.contextDigest,
        });
        if (input.follow === true)
          inbox.follow(
            input.id,
            input.goal,
            inbox.get(input.id).simulated ? "fixture" : "codex",
          );
        const c = conversations.get(owner, result.conversationId);
        json(res, 200, { ...result, conversation: c });
        if (c.status === "queued") setImmediate(launch);
        return;
      }
      throw Error("UnsupportedBeeContextCommand");
    }
    if (url.pathname === "/api/tasks") {
      let text = input.text,
        source = input.fixture ? "fixture" : "typed",
        capture = null;
      if (input.captureId || input.recovered)
        throw Error(
          "UnsupportedLegacyBeeInput: select Bee context in the companion",
        );
      const task = await run(
        h.create(
          owner,
          text,
          source,
          null,
          capture,
          input.provider === "codex",
        ),
      );
      json(res, 200, task);
      if (task.status === "interpretation_queued") setImmediate(launch);
      return;
    }
    if (url.pathname === "/api/command") {
      const t = await run(h.command(owner, input.taskId, input.command));
      json(res, 200, t);
      if (["queued", "interpretation_queued"].includes(t.status))
        setImmediate(launch);
      return;
    }
    if (url.pathname === "/api/memory") {
      let memoryInput = input;
      if (input.action === "save-conversation") {
        const c = conversations.get(owner, input.conversationId);
        if (c.status !== "completed") throw Error("ReviewFirst");
        if (c.version !== input.version) throw Error("StaleRevision");
        memoryInput = { conversation: c };
      }
      const result = await run(h.memory(owner, input.action, memoryInput));
      if (["edit", "delete"].includes(input.action))
        conversations.revokeMemory(owner, input.id);
      return json(res, 200, result);
    }
    if (url.pathname === "/api/conversation") {
      let c;
      if (input.action === "create") {
        if (
          input.memoryIds !== undefined &&
          (!Array.isArray(input.memoryIds) ||
            input.memoryIds.length > 10 ||
            input.memoryIds.some(
              (id) => typeof id !== "string" || id.startsWith("bee:"),
            ))
        )
          throw Error(
            "SelectedBeeContextProviderConsentRequired: use Bee source selection, not direct saved-context IDs",
          );
        c = conversations.create(
          owner,
          input.text,
          input.mode,
          input.memoryIds ?? [],
          input.fixtureKind ?? "workshop",
        );
      } else if (input.action === "send") {
        c = conversations.send(owner, input.id, input.text, input.version);
        if (c.source)
          inbox.updateFollow(c.source.id, {
            instruction: input.text,
            context: progressContext(c),
          });
      } else if (input.action === "command") {
        if (input.command.type === "approve")
          await revalidate(conversations.get(owner, input.id));
        c = conversations.command(owner, input.id, input.command);
        if (c.source) {
          if (input.command.type === "cancel") {
            inbox.stopFollow(c.source.id);
            conversations.cancelSource(owner, c.source.id);
            stopStreamIfUnscoped();
          } else
            inbox.updateFollow(c.source.id, {
              context: progressContext(c),
              ...(["pause", "resume"].includes(input.command.type)
                ? {
                    pausedReason:
                      input.command.type === "pause" ? "OwnerPaused" : null,
                  }
                : {}),
            });
          stopStreamIfUnscoped();
        }
      } else throw Error("UnsupportedCommand");
      json(res, 200, c);
      if (["queued", "action_queued"].includes(c.status)) setImmediate(launch);
      return;
    }
    if (url.pathname === "/api/provider/connect")
      return json(res, 200, await provider.connect());
    if (url.pathname === "/api/bee/discovery") {
      if (typeof input.enabled !== "boolean" || input.confirmed !== true)
        throw Error("ExplicitDiscoveryConsentRequired");
      supervisor.setDiscoveryEnabled(input.enabled);
      return json(res, 200, supervisor.status());
    }
    if (url.pathname === "/api/bee/start") {
      await supervisor.startStream();
      return json(res, 200, bee.status());
    }
    if (url.pathname === "/api/bee/stop") {
      supervisor.stopStream();
      return json(res, 200, bee.status());
    }
    return json(res, 404, { error: "NotFound" });
  } catch (e) {
    json(res, e.existingConversationId ? 409 : httpErrorStatus(e), {
      error: String(e.message ?? e).slice(0, 800),
      ...(e.existingConversationId
        ? { existingConversationId: e.existingConversationId }
        : {}),
    });
  }
});
inbox.reconcileClaims(taskFromSource);
server.listen(port, "127.0.0.1", async () => {
  console.log("Local companion: " + origin);
  if (
    conversations
      .list(owner)
      .some((c) => ["queued", "action_queued"].includes(c.status))
  )
    setImmediate(launch);
  for (const t of await run(h.list(owner)))
    if (["queued", "interpretation_queued"].includes(t.status))
      setImmediate(launch);
});
async function shutdown() {
  clearInterval(followTimer);
  supervisor.close();
  mcp.close();
  provider.close();
  server.close();
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

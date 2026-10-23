import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { RpcClient } from "../src/codex-provider.mjs";
test("app-server RPC correlates responses and denies execution requests without touching credentials", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit("exit", 0));
  const sent = [];
  child.stdin.on("data", (b) => sent.push(JSON.parse(b.toString())));
  const rpc = new RpcClient(child);
  const result = rpc.request("account/read", { refreshToken: false });
  const frame = sent[0];
  assert.equal(frame.method, "account/read");
  child.stdout.write(
    JSON.stringify({
      id: frame.id,
      result: { account: { type: "chatgpt", planType: "plus" } },
    }) + "\n",
  );
  assert.equal((await result).account.type, "chatgpt");
  child.stdout.write(
    JSON.stringify({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { command: "anything" },
    }) + "\n",
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.at(-1), { id: 99, result: { decision: "decline" } });
  rpc.close();
});
import {
  createCodexProvider,
  isolationOverrides,
  lunaServiceTier,
} from "../src/codex-provider.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function fakeProvider(mode, { confirmExit = true, serviceTiers } = {}) {
  let killed = 0,
    child,
    turnStarted;
  const methods = [],
    frames = [],
    launches = [];
  const started = new Promise((r) => (turnStarted = r));
  const p = createCodexProvider({
    directory: mkdtempSync(join(tmpdir(), "bee-rpc-")),
    requestTimeoutMs: 30,
    turnTimeoutMs: 100,
    spawnProcess: (binary, args, options) => {
      launches.push({ binary, args, options });
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {
        killed++;
        if (confirmExit) queueMicrotask(() => child.emit("exit", 0));
      };
      let accountReads = 0;
      child.stdin.on("data", (b) => {
        const m = JSON.parse(b);
        methods.push(m.method);
        frames.push(m);
        if (m.method === "initialize" && mode === "unanswered-initialize")
          return;
        if (m.method === "initialize" && mode === "malformed-initialize") {
          queueMicrotask(() => child.stdout.write("malformed\n"));
          return;
        }
        if (
          m.method === "account/read" &&
          mode === "status-timeout" &&
          ++accountReads > 1
        )
          return;
        let result = {};
        if (m.method === "config/read")
          result = {
            config: {
              mcp_servers: {},
              features: Object.fromEntries(
                Object.entries(isolationOverrides)
                  .filter(([k]) => k.startsWith("features."))
                  .map(([k, v]) => [k.slice(9), v]),
              ),
            },
          };
        if (m.method === "account/read")
          result = {
            account: mode === "logged-out" ? null : { type: "chatgpt" },
          };
        if (m.method === "model/list")
          result = {
            data: [
              {
                model: "gpt-6-luna",
                ...(serviceTiers === undefined ? {} : { serviceTiers }),
                supportedReasoningEfforts: [{ reasoningEffort: "low" }],
              },
            ],
          };
        if (m.method === "thread/start")
          result = {
            model: "gpt-6-luna",
            modelProvider: "openai",
            instructionSources: [],
            thread: { id: "t" },
          };
        if (m.method === "turn/start") {
          turnStarted();
          if (mode === "tier-rejected") {
            queueMicrotask(() => child.stdout.write(JSON.stringify({ id: m.id, error: { message: "unsupported service tier" } }) + "\n"));
            return;
          }
          if (mode === "lost") return;
          result = { turn: { id: "u" } };
          if (mode === "overflow" || mode === "delta")
            queueMicrotask(() =>
              child.stdout.write(
                JSON.stringify({
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: "t",
                    delta: mode === "overflow" ? "x".repeat(16001) : "hello",
                  },
                }) + "\n",
              ),
            );
        }
        if (m.method === "turn/interrupt") {
          child.stdout.write(
            JSON.stringify({
              id: m.id,
              error: { message: "interrupt denied" },
            }) + "\n",
          );
          return;
        }
        if (m.id)
          queueMicrotask(() =>
            child.stdout.write(JSON.stringify({ id: m.id, result }) + "\n"),
          );
      });
      return child;
    },
  });
  return {
    p,
    started,
    setFakeAccountAvailable: () => {
      mode = "ok";
    },
    killed: () => killed,
    methods,
    frames,
    launches,
    exit: () => child.emit("exit", 0),
    write: (line) => child.stdout.write(line),
  };
}
test("lost turn start outcome resets dedicated process before returning failure", async () => {
  const f = fakeProvider("lost");
  await f.p.doctor();
  await assert.rejects(f.p.interpret("reminder due now"), /ProviderTimeout/);
  assert.ok(f.killed() > 0);
  assert.equal((await f.p.status()).started, false);
});
test("oversized streamed output resets process even when interrupt is rejected", async () => {
  const f = fakeProvider("overflow");
  await f.p.doctor();
  await assert.rejects(
    f.p.interpret("reminder due now"),
    /ProviderOutputLimit/,
  );
  assert.ok(f.killed() > 0);
  assert.equal((await f.p.status()).started, false);
});

import { verifyProposalThread, RUNTIME_MODEL } from "../src/codex-provider.mjs";
test("runtime is Luna only and fails before inference on imported instruction sources", () => {
  assert.equal(RUNTIME_MODEL, "gpt-6-luna");
  assert.throws(
    () =>
      verifyProposalThread({ model: "gpt-6.1-sol", instructionSources: [] }),
    /UnexpectedRuntimeModel/,
  );
  assert.throws(
    () =>
      verifyProposalThread({
        model: RUNTIME_MODEL,
        modelProvider: "openai",
        instructionSources: ["/private/AGENTS.md"],
      }),
    /UnreviewedInstructionSource/,
  );
  assert.equal(
    verifyProposalThread({
      model: RUNTIME_MODEL,
      modelProvider: "openai",
      instructionSources: [],
      thread: { id: "clean" },
    }).thread.id,
    "clean",
  );
});
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
test("reviewed ordinary instruction metadata is accepted only while its hash remains unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "bee-guidance-")),
    path = join(directory, "AGENTS.md"),
    text = "Ordinary coding guidance";
  writeFileSync(path, text);
  const reviewed = { [path]: createHash("sha256").update(text).digest("hex") };
  assert.equal(
    verifyProposalThread(
      {
        model: RUNTIME_MODEL,
        modelProvider: "openai",
        instructionSources: [path],
      },
      reviewed,
    ).model,
    RUNTIME_MODEL,
  );
  writeFileSync(path, "Changed guidance");
  assert.throws(
    () =>
      verifyProposalThread(
        {
          model: RUNTIME_MODEL,
          modelProvider: "openai",
          instructionSources: [path],
        },
        reviewed,
      ),
    /ReviewedGuidanceChanged/,
  );
});

test("existing-account connect never starts OAuth and model-provider mismatch fails closed", async () => {
  const f = fakeProvider("idle");
  const c = await f.p.connect();
  assert.equal(c.existingConnection, true);
  assert.equal(c.model, "gpt-6-luna");
  assert.equal(f.methods.includes("account/login/start"), false);
  assert.ok(f.methods.includes("account/read"));
  f.p.close();
  assert.throws(
    () =>
      verifyProposalThread({
        model: RUNTIME_MODEL,
        modelProvider: "third-party",
        instructionSources: [],
      }),
    /UnexpectedModelProvider/,
  );
});

test("provider state/logs are temporary and not mirrored under the app data directory", async () => {
  const f = fakeProvider("idle");
  await f.p.connect();
  const launch = f.launches[0];
  const sqlite = JSON.parse(
    launch.args
      .find((a) => a.startsWith("sqlite_home="))
      .split("=")
      .slice(1)
      .join("="),
  );
  const log = JSON.parse(
    launch.args
      .find((a) => a.startsWith("log_dir="))
      .split("=")
      .slice(1)
      .join("="),
  );
  assert.equal(sqlite, log);
  assert.notEqual(sqlite, launch.options.env.TMPDIR);
  assert.match(sqlite, /bee-companion-codex-/);
  const { existsSync, readdirSync } = await import("node:fs");
  assert.ok(
    !readdirSync(launch.options.env.TMPDIR).some((n) =>
      /^state_.*\.sqlite/.test(n),
    ),
  );
  f.p.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(existsSync(sqlite), false);
});

for (const mode of ["malformed-initialize", "unanswered-initialize"]) {
  test(`${mode} terminates the owned child before initialization fails`, async () => {
    const f = fakeProvider(mode);
    await assert.rejects(
      f.p.connect(),
      mode === "malformed-initialize"
        ? /InvalidProviderFrame/
        : /ProviderTimeout/,
    );
    assert.equal(f.killed(), 1);
    assert.equal((await f.p.status()).started, false);
    await f.p.close();
  });
}
test("throwing notification consumer terminates the owned child before releasing the turn", async () => {
  const f = fakeProvider("delta");
  await f.p.connect();
  await assert.rejects(
    f.p.interpret("reminder due now", {
      onDelta: () => {
        throw Error("consumer failed");
      },
    }),
    /InvalidProviderFrame/,
  );
  assert.equal(f.killed(), 1);
  assert.equal((await f.p.status()).started, false);
  await f.p.close();
});
test("malformed output suppresses reconnect while owned process exit is unconfirmed", async () => {
  const f = fakeProvider("idle", { confirmExit: false });
  await f.p.connect();
  const launch = f.launches[0];
  const sqlite = JSON.parse(
    launch.args
      .find((a) => a.startsWith("sqlite_home="))
      .slice("sqlite_home=".length),
  );
  f.write("malformed\n");
  const connecting = f.p.connect();
  await assert.rejects(connecting, /ProviderTerminationUncertain/);
  assert.equal(f.launches.length, 1);
  await assert.rejects(f.p.connect(), /ProviderTerminationUncertain/);
  await f.p.close();
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(sqlite), true);
  f.exit();
  assert.equal(existsSync(sqlite), false);
  assert.equal(f.killed(), 2);
});
test("reconnect waits for exit confirmation after malformed output", async () => {
  const f = fakeProvider("idle", { confirmExit: false });
  await f.p.connect();
  f.write("malformed\n");
  const connecting = f.p.connect();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.launches.length, 1);
  f.exit();
  await connecting;
  assert.equal(f.launches.length, 2);
  const closing = f.p.close();
  f.exit();
  await closing;
});

test("status timeout reset permits reconnect only after the owned process exits", async () => {
  const f = fakeProvider("status-timeout", { confirmExit: false });
  await f.p.connect();
  const pendingStatus = assert.rejects(f.p.status(), /ProviderClosed/);
  const reset = f.p.reset();
  const connecting = f.p.connect();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.launches.length, 1);
  assert.equal(f.killed(), 1);
  f.exit();
  assert.equal(await reset, true);
  await pendingStatus;
  assert.equal((await connecting).connected, true);
  assert.equal(f.launches.length, 2);
  const closing = f.p.close();
  f.exit();
  await closing;
  await assert.rejects(f.p.connect(), /ProviderClosed/);
});
test("status timeout reset blocks reconnect if owned exit cannot be confirmed", async () => {
  const f = fakeProvider("idle", { confirmExit: false });
  await f.p.connect();
  assert.equal(await f.p.reset(), false);
  await assert.rejects(f.p.connect(), /ProviderTerminationUncertain/);
  assert.equal(f.launches.length, 1);
  f.exit();
  await f.p.close();
});

test("companion transport uses the exact bounded guidance request without expanding tool access", async () => {
  const { buildCompanionRequest, measureProposalInput } = await import(
    "../src/proposal-request.mjs"
  );
  const input = {
    messages: [
      {
        role: "user",
        text: "Review frontend accessibility; do not modify files.",
      },
    ],
    memory: [],
    artifacts: [],
    intentChanges: [],
  };
  const request = buildCompanionRequest(input),
    f = fakeProvider("guidance");
  try {
    const resultPromise = f.p.converse({
      ...input,
      requestGuidance: { revision: 1, ...request.provenance },
    });
    await f.started;
    const thread = f.frames.find((x) => x.method === "thread/start").params;
    const turn = f.frames.find((x) => x.method === "turn/start").params;
    assert.equal(thread.developerInstructions, request.instructions);
    assert.equal(thread.baseInstructions, request.baseInstructions);
    assert.deepEqual(turn.input, [
      { type: "text", text: "Selected request:\n" + request.text },
    ]);
    assert.equal(
      measureProposalInput({
        text: request.text,
        instructions: thread.developerInstructions,
        baseInstructions: thread.baseInstructions,
        outputSchema: turn.outputSchema,
      }),
      request.inputBytes,
    );
    assert.equal(thread.sandbox, "read-only");
    assert.equal(thread.ephemeral, true);
    f.write(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "t",
          item: {
            type: "agentMessage",
            text: JSON.stringify({
              reply: "Source-only draft; no rendered review or file changes.",
              questions: [],
              steps: [],
            }),
          },
        },
      }) + "\n",
    );
    f.write(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "t", turn: { status: "completed" } },
      }) + "\n",
    );
    const result = await resultPromise;
    assert.deepEqual(result.guidance, request.provenance);
    assert.equal(result.model, "gpt-6-luna");
    assert.equal(isolationOverrides["skills.include_instructions"], false);
  } finally {
    await f.p.close();
  }
});
test("invalid guidance bindings and aggregate input overflow fail before any provider connection", async () => {
  const { buildCompanionRequest } = await import("../src/proposal-request.mjs");
  const f = fakeProvider("guidance"),
    input = { messages: [{ role: "user", text: "Plan locally" }], memory: [] };
  const request = buildCompanionRequest(input);
  await assert.rejects(
    f.p.converse({
      ...input,
      requestGuidance: {
        revision: 1,
        ...request.provenance,
        packHash: "0".repeat(64),
      },
    }),
    /GuidanceRequestRevisionMismatch/,
  );
  await assert.rejects(
    f.p.converse({
      messages: [{ role: "user", text: "🐝".repeat(8000) }],
      memory: [],
    }),
    /ContextBudget/,
  );
  assert.equal(f.launches.length, 0);
  await f.p.close();
});

test("fake logged-out account gives an actionable user-owned setup step and can reconnect without starting login or inference", async () => {
  const f = fakeProvider("logged-out");
  try {
    await assert.rejects(
      f.p.connect(),
      /Sign in with ChatGPT in the official Codex app or CLI/,
    );
    assert.equal((await f.p.status()).connected, false);
    assert.equal(
      f.methods.some((m) => m.includes("login") || m === "turn/start"),
      false,
    );
    f.setFakeAccountAvailable();
    assert.equal((await f.p.connect()).connected, true);
    assert.equal(f.methods.includes("turn/start"), false);
  } finally {
    await f.p.close();
  }
});


test("Luna fast mode uses advertised official tiers and otherwise keeps standard Luna", () => {
  assert.equal(lunaServiceTier({ serviceTiers: [{ id: "fast" }] }), "fast");
  assert.equal(lunaServiceTier({ serviceTiers: [{ id: "priority" }] }), "priority");
  assert.equal(lunaServiceTier({ additionalSpeedTiers: ["fast"] }), "fast");
  assert.equal(lunaServiceTier({ serviceTiers: [], additionalSpeedTiers: ["fast"] }), "default");
  assert.equal(lunaServiceTier({ serviceTiers: [{ id: "ultrafast" }] }), "default");
  assert.equal(lunaServiceTier({}), "default");
});
for (const tier of ["fast", "priority", "default"]) {
  test(`Luna ${tier} reaches thread and turn parameters without changing reasoning`, async () => {
    const f = fakeProvider("delta", { serviceTiers: tier === "default" ? [] : [{ id: tier }] });
    try {
      const pending = f.p.interpret("Synthetic reminder due now");
      await f.started;
      const thread = f.frames.find((frame) => frame.method === "thread/start").params;
      const turn = f.frames.find((frame) => frame.method === "turn/start").params;
      assert.equal(thread.serviceTier, tier);
      assert.equal(turn.serviceTier, tier);
      assert.equal(turn.model, "gpt-6-luna");
      assert.equal(turn.effort, "low");
      f.write(JSON.stringify({ method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: JSON.stringify({ summary: "Synthetic", workflow: "unsupported", inclusive: false, excludeCompleted: true, questions: [] }) } } }) + "\n");
      f.write(JSON.stringify({ method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } }) + "\n");
      const result = await pending;
      assert.equal(result.serviceTierRequested, tier);
      assert.equal(result.fastModeRequested, true);
      assert.equal(result.serviceTierConfigured, null);
      assert.equal(f.frames.filter((frame) => frame.method === "turn/start").length, 1);
    } finally { await f.p.close(); }
  });
}

test("a rejected fast turn fails safely without replay or model substitution", async () => {
  const f = fakeProvider("tier-rejected", { serviceTiers: [{ id: "fast" }] });
  try {
    await assert.rejects(f.p.interpret("Synthetic only"), /unsupported service tier/);
    assert.equal(f.frames.filter((frame) => frame.method === "turn/start").length, 1);
    assert.equal(f.frames.find((frame) => frame.method === "turn/start").params.model, "gpt-6-luna");
    assert.equal(isolationOverrides["features.fast_mode"], true);
    assert.ok(f.killed() > 0);
  } finally { await f.p.close(); }
});

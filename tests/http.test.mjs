import { request as httpRequest } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
test("loopback HTTP rejects unauthenticated and cross-origin mutations; accepts bounded same-origin command", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000),
    origin = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    env: {
      ...process.env,
      BEE_COMPANION_PORT: String(port),
      BEE_COMPANION_DATA: mkdtempSync(join(tmpdir(), "bee-http-")),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(Error("Server timeout")), 5000);
      child.stdout.on("data", (b) => {
        output += b;
        if (output.includes("Local companion:")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", reject);
    });
    assert.equal((await fetch(origin + "/api/snapshot")).status, 401);
    const landing = await fetch(origin);
    const landingHtml = await landing.text();
    assert.match(landingHtml, /<title>BeeBot<\/title>/);
    const logo = await fetch(origin + "/beebot.svg");
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await logo.text(), /<svg/);
    assert.doesNotMatch(landingHtml, /href="\/setup"/);
    const setup = await fetch(origin + "/setup");
    assert.equal(setup.status, 200);
    assert.match(setup.headers.get("content-type"), /text\/html/);
    const guide = (await setup.text()).replace(/\s+/g, " ");
    assert.match(guide, /First test/);
    assert.match(guide, /Prepared for a connection test/);
    assert.match(guide, /review-guidance -- --acknowledge/);
    assert.ok(guide.indexOf("review-guidance -- --acknowledge") < guide.indexOf("npm start"));
    assert.match(guide, /stop its Terminal process with Ctrl-C and restart/);
    const samples = [
      ...guide.matchAll(/<blockquote>([\s\S]*?)<\/blockquote>/g),
    ].map((m) => m[1]);
    assert.ok(samples.length >= 1);
    for (const sample of samples)
      assert.ok(
        sample.trim().split(/\s+/).length >= 80 &&
          sample.trim().split(/\s+/).length <= 100,
      );
    assert.match(guide, /roughly 50 words/);
    assert.match(guide, /actual processed transcript/);
    assert.match(
      guide,
      /Phone proximity is neither confirmed required nor confirmed unnecessary/,
    );
    assert.match(guide, /node_modules\/\.bin\/bee login/);
    assert.match(guide, /href="\/setup\.css"/);
    assert.match(guide, /<details>/);
    assert.ok(guide.indexOf("First test") < guide.indexOf("Full setup"));
    const css = await fetch(origin + "/setup.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.match(await css.text(), /summary/);
    const cookie = landing.headers.get("set-cookie").split(";")[0];
    const snapshot = await (
      await fetch(origin + "/api/snapshot", { headers: { cookie } })
    ).json();
    const input = { text: "Reminder due exactly now", fixture: true };
    const headers = {
      cookie,
      "content-type": "application/json",
      "x-bee-csrf": snapshot.csrf,
      origin: "https://example.com",
    };
    assert.equal(
      (
        await fetch(origin + "/api/tasks", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    headers.origin = origin;
    const created = await fetch(origin + "/api/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(created.status, 200);
    const t = await created.json();
    assert.equal(t.status, "clarifying");
    assert.equal(t.simulated, true);
    assert.equal(
      (
        await fetch(origin + "/api/tasks", {
          method: "POST",
          headers: { ...headers, "x-bee-csrf": "wrong" },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    const post = async (path, data, extra = {}) =>
      fetch(origin + path, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(data),
      });
    const rawStatus = (host, path = "/", data = null) =>
      new Promise((resolve, reject) => {
        const r = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method: data ? "POST" : "GET",
            headers: { ...headers, host, origin: "http://" + host },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        r.on("error", reject);
        r.end(data ? JSON.stringify(data) : undefined);
      });
    assert.equal(await rawStatus("localhost:" + port), 200);
    assert.equal(await rawStatus("localhost.evil:" + port), 403);
    assert.equal(
      await rawStatus("localhost:" + port, "/api/tasks", input),
      200,
    );
    assert.equal((await post("/api/tasks", { captureId: "fake" })).status, 400);
    const recovered = await (
      await post("/api/bee/context", {
        action: "recover",
        text: "Synthetic recovered source, no authority",
      })
    ).json();
    assert.equal(recovered.transport, "manual-recovery");
    assert.equal(recovered.authorized, false);
    assert.equal(
      (
        await post("/api/conversation", {
          action: "create",
          text: "Bypass source selection",
          mode: "codex",
          memoryIds: ["bee:" + recovered.id],
        })
      ).status,
      400,
    );
    let c = await (
      await post("/api/conversation", {
        action: "create",
        text: "Help plan workshop",
        mode: "fixture",
      })
    ).json();
    const waitFor = async (statuses) => {
      for (let i = 0; i < 50; i++) {
        const snap = await (
          await fetch(origin + "/api/snapshot", { headers: { cookie } })
        ).json();
        c = snap.conversations.find((x) => x.id === c.id);
        if (statuses.includes(c.status)) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("Fixture transition timeout");
    };
    await waitFor(["clarifying"]);
    assert.equal(
      (
        await post("/api/memory", {
          action: "save-conversation",
          conversationId: c.id,
          version: c.version,
        })
      ).status,
      400,
    );
    c = await (
      await post("/api/conversation", {
        action: "send",
        id: c.id,
        version: c.version,
        text: "45 minutes for beginners",
      })
    ).json();
    await waitFor(["review_required"]);
    c = await (
      await post("/api/conversation", {
        action: "command",
        id: c.id,
        command: { id: "accept-result", type: "accept", version: c.version },
      })
    ).json();
    assert.equal(c.status, "completed");
    const memory = await (
      await post("/api/memory", {
        action: "save-conversation",
        conversationId: c.id,
        version: c.version,
      })
    ).json();
    assert.equal(memory.sourceProvenance.conversationId, c.id);
    assert.equal(
      (
        await post("/api/conversation", {
          action: "command",
          id: c.id,
          command: { id: "closed-pause", type: "pause", version: c.version },
        })
      ).status,
      400,
    );
  } finally {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }
});

import {
  allowedHost,
  allowedOrigin,
  createProviderStatusCache,
  readJsonBody,
  httpErrorStatus,
} from "../src/http-boundaries.mjs";
test("snapshot provider cache coalesces reads, times out once and closes owned process", async () => {
  let now = 1,
    calls = 0,
    closed = 0;
  const status = createProviderStatusCache({
    clock: () => now,
    ttlMs: 100,
    timeoutMs: 10,
    provider: {
      status: () => {
        calls++;
        return new Promise(() => {});
      },
      close: () => closed++,
    },
  });
  const [a, b] = await Promise.all([status(), status()]);
  assert.equal(a.connected, false);
  assert.equal(b.error, "ProviderStatusTimeout");
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  await status();
  assert.equal(calls, 1);
  now = 200;
  await status();
  assert.equal(calls, 2);
  assert.equal(closed, 2);
});
test("host/origin validation permits exact loopback aliases while denying rebinding and mixed aliases", () => {
  assert.ok(allowedHost("localhost:8767", 8767));
  assert.ok(allowedOrigin("http://localhost:8767", "localhost:8767", 8767));
  assert.ok(allowedOrigin("http://127.0.0.1:8767", "127.0.0.1:8767", 8767));
  for (const host of [
    "localhost.evil:8767",
    "evil:8767",
    "localhost:8768",
    "127.0.0.1:8767@evil",
  ])
    assert.equal(allowedHost(host, 8767), false);
  assert.equal(
    allowedOrigin("http://localhost:8767", "127.0.0.1:8767", 8767),
    false,
  );
  assert.equal(httpErrorStatus(Error("disk exploded")), 500);
  assert.equal(httpErrorStatus(Error("InvalidInput")), 400);
});
test("chunked UTF-8 body preserves split emoji and non-ASCII text exactly", async () => {
  const text = "Plants 🌱 café नमस्ते";
  const bytes = Buffer.from(JSON.stringify({ text }));
  const req = (async function* () {
    for (const byte of bytes) yield Buffer.from([byte]);
  })();
  assert.equal((await readJsonBody(req)).text, text);
});

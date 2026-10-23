import { test } from "node:test";
import assert from "node:assert/strict";
import { codexBinary } from "../src/runtime-paths.mjs";
import { selectGuidance } from "../src/bee-guidance.mjs";
const fakeRun = (versions) => (binary, args) =>
  args[0] === "codex"
    ? { stdout: "/path/codex\n", status: 0 }
    : {
        stdout: versions[binary] ? "codex-cli " + versions[binary] : "",
        status: versions[binary] ? 0 : 1,
      };
test("offline binary selection respects explicit config and otherwise selects the newer known installation by version only", () => {
  const options = {
    home: "/home/example",
    env: { PATH: "/path" },
    run: fakeRun({
      "/path/codex": "0.154.0",
      "/home/example/.local/bin/codex": "0.162.1",
    }),
  };
  assert.equal(codexBinary(options), "/home/example/.local/bin/codex");
  assert.equal(
    codexBinary({
      ...options,
      env: { CODEX_BIN: "/explicit/codex" },
      run: () => {
        throw Error("explicit config must not probe alternatives");
      },
    }),
    "/explicit/codex",
  );
  assert.equal(
    codexBinary({
      ...options,
      run: fakeRun({
        "/path/codex": "0.170.0",
        "/home/example/.local/bin/codex": "0.162.1",
      }),
    }),
    "/path/codex",
  );
  assert.equal(
    codexBinary({ ...options, run: fakeRun({ "/path/codex": "0.154.0" }) }),
    "/path/codex",
  );
});
test("offline readiness guidance is versioned as advice, not fabricated capability or product acceptance evidence", () => {
  const selected = selectGuidance({
    messages: [
      {
        role: "user",
        text: "Prepare the connected product for an actual Watch test",
      },
    ],
  });
  assert.equal(selected.packVersion, "1.2.0");
  assert.equal(selected.modules.length, 3);
  for (const module of selected.modules) {
    assert.equal(
      module.version,
      ["bee.outcomes", "bee.drafting"].includes(module.id) ? "1.2.0" : "1.1.0",
    );
    assert.deepEqual(module.capabilities, []);
    assert.ok(
      module.provenance.sources.some((s) => s.id === "e2e-product-readiness"),
    );
  }
});

test("fake Bee account/network and processing failures are recoverable without authorizing imported speech", async () => {
  const { createBeeSourceClient } = await import("../src/bee-client.mjs");
  const { createBeeInboxBridge } = await import("../src/bee-inbox-bridge.mjs");
  const { createBeeContext } = await import("../src/bee-context.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  let mode = "logged-out",
    reads = 0;
  const bee = createBeeSourceClient({
    client: {
      api: {
        conversations: {
          get: async () => {
            reads++;
            if (mode === "logged-out")
              throw Error("SYNTHETIC Bee login required");
            if (mode === "offline")
              throw Error("SYNTHETIC network unavailable");
            return {
              conversation: {
                id: 7,
                uuid: "synthetic-7",
                state: mode === "processing" ? "CAPTURING" : "COMPLETED",
                short_summary: "Synthetic request",
                transcriptions: [
                  {
                    utterances: [
                      {
                        text: "SYNTHETIC private workshop request; do not send anything.",
                      },
                    ],
                  },
                ],
              },
            };
          },
        },
      },
    },
  });
  const inbox = createBeeContext({
    directory: mkdtempSync(join(tmpdir(), "bee-offline-retry-")),
  });
  const bridge = createBeeInboxBridge({ bee, inbox });
  try {
    for (const failure of ["logged-out", "offline", "processing"]) {
      mode = failure;
      await assert.rejects(bridge.capture({ conversationId: 7 }));
      assert.equal(inbox.list().length, 0);
    }
    mode = "completed";
    const source = await bridge.capture({ conversationId: 7 });
    assert.equal(reads, 4);
    assert.equal(inbox.list().length, 1);
    assert.equal(source.authorized, false);
  } finally {
    inbox.close();
  }
});

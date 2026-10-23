import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarness } from "../src/harness.mjs";
import * as visuals from "../public/visuals.mjs";
const field = () => ({
  textContent: "",
  hidden: true,
  attrs: new Map(),
  setAttribute(k, v) {
    this.attrs.set(k, v);
  },
  removeAttribute(k) {
    this.attrs.delete(k);
  },
});
test("past or invalid expiry gives a future-date instruction; unchanged expiry preserves its exact instant and explicit clear stays null", () => {
  const options = {
    initialValue: "2030-01-01T12:00",
    currentExpiry: 1893499200456,
    now: () => 1000,
  };
  assert.equal(
    visuals.memoryExpiryResult("1960-01-01T00:00", options).error,
    "Choose a future date and time, or clear expiry.",
  );
  assert.ok(visuals.memoryExpiryResult("bad", options).error);
  assert.equal(
    visuals.memoryExpiryResult(options.initialValue, options).expiresAt,
    options.currentExpiry,
  );
  assert.equal(visuals.memoryExpiryResult("", options).expiresAt, null);
  assert.equal(
    visuals.memoryExpiryResult("2031-01-01T12:00", options).error,
    null,
  );
});
test("editor feedback is field-specific, retains real save failures, and clears without leaking into another editor", () => {
  const expiry = field(),
    expiryError = field(),
    formError = field();
  const feedback = visuals.createMemoryFeedback({
    expiry,
    expiryError,
    formError,
  });
  feedback.show(
    "InvalidMemoryExpiry: Choose a future date and time, or clear expiry.",
  );
  assert.match(expiryError.textContent, /future date/);
  assert.equal(expiryError.hidden, false);
  assert.equal(expiry.attrs.get("aria-invalid"), "true");
  assert.equal(formError.hidden, true);
  feedback.clear();
  assert.equal(expiryError.hidden, true);
  assert.equal(expiry.attrs.has("aria-invalid"), false);
  feedback.show("Worker unavailable");
  assert.equal(formError.hidden, false);
  assert.match(formError.textContent, /not saved.*Worker unavailable/i);
  const otherError = field();
  const other = visuals.createMemoryFeedback({
    expiry: field(),
    expiryError: otherError,
    formError: field(),
  });
  assert.equal(otherError.hidden, true);
  other.clear();
  assert.equal(formError.hidden, false);
  feedback.clear();
  assert.equal(formError.hidden, true);
});
test("backend rejects a past expiry with actionable detail and leaves the memory text, version and expiry unchanged", async () => {
  const h = createHarness({
    directory: mkdtempSync(join(tmpdir(), "bee-expiry-")),
    clock: () => 1000,
  });
  try {
    const c = {
      id: "accepted",
      owner: "owner",
      status: "completed",
      revision: 1,
      version: 1,
      messages: [{ role: "user", text: "Keep plans private" }],
      steps: [],
      artifacts: [],
    };
    const m = await Effect.runPromise(
      h.memory("owner", "save-conversation", { conversation: c }),
    );
    await assert.rejects(
      Effect.runPromise(
        h.memory("owner", "edit", {
          id: m.id,
          text: "Unsaved correction",
          expiresAt: 999,
        }),
      ),
      /InvalidMemoryExpiry: Choose a future date and time, or clear expiry/,
    );
    assert.deepEqual(
      (await Effect.runPromise(h.memory("owner", "list")))[0],
      m,
    );
  } finally {
    h.close();
  }
});

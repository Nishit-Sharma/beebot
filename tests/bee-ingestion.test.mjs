import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeBeeLine } from "../src/bee-ingestion.mjs";
const context = {
  session: "fixture-session",
  sequence: 0,
  receivedAt: "2026-10-21T00:00:00Z",
  simulated: true,
};
const fixture = readFileSync(
  new URL("../fixtures/bee-stream.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n");
test("documented structural Bee payload decodes without a synthetic event key", () => {
  const e = decodeBeeLine(fixture[0], context);
  assert.equal(e.text, "When a reminder is due exactly now, show it as due.");
  assert.equal(e.providerReference, "fixture-conversation-1");
  assert.equal(e.simulated, true);
  assert.equal(e.authorized, false);
});
test("recovered speech remains unauthorized even if it sounds imperative", () => {
  const e = decodeBeeLine(fixture[0], { ...context, recovered: true });
  assert.equal(e.recovered, true);
  assert.equal(e.authorized, false);
});
test("repeated words retain transport sequence, not invented provider event IDs", () => {
  const a = decodeBeeLine(fixture[0], context),
    b = decodeBeeLine(fixture[0], { ...context, sequence: 1 });
  assert.equal(a.text, b.text);
  assert.notEqual(a.sequence, b.sequence);
  assert.equal(Object.hasOwn(a, "providerEventId"), false);
});
test("unrelated Bee event is ignored", () =>
  assert.equal(decodeBeeLine('{"todo":{"id":1}}', context), null));
test("malformed and oversized payloads fail closed", () => {
  for (const line of [
    "null",
    "[]",
    "{",
    '{"utterance":{"text":1}}',
    "x".repeat(65537),
  ])
    assert.throws(() => decodeBeeLine(line, context));
});
test("receiver metadata must be valid", () => {
  assert.throws(() => decodeBeeLine(fixture[0], { ...context, sequence: -1 }));
  assert.throws(() =>
    decodeBeeLine(fixture[0], { ...context, receivedAt: "yesterday" }),
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPrimaryNavigation } from "./navigation-browser-check.mjs";
const sample = () => ({
  viewport: { width: 320, height: 640 },
  documentWidth: 320,
  buttons: ["inbox", "work", "memory", "connections"].map((page, i) => ({
    page,
    name: page,
    x: 14 + (i % 2) * 148,
    y: 50 + Math.floor(i / 2) * 48,
    width: 144,
    height: 44,
    visible: true,
    reachable: true,
  })),
});
test("browser navigation assertion detects overflow, clipped/unnamed/unreachable destinations and reduced touch targets", () => {
  assert.doesNotThrow(() => assertPrimaryNavigation(sample()));
  for (const mutate of [
    (m) => (m.documentWidth = 383),
    (m) => (m.buttons[3].x = 239.07),
    (m) => (m.buttons[3].visible = false),
    (m) => (m.buttons[3].name = ""),
    (m) => (m.buttons[3].reachable = false),
    (m) => (m.buttons[3].height = 30),
  ]) {
    const m = sample();
    mutate(m);
    assert.throws(() => assertPrimaryNavigation(m));
  }
});

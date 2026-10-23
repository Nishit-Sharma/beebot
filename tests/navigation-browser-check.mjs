import assert from "node:assert/strict";
/** Run this function in the attended review browser after setting each viewport/text scale. */
export function measurePrimaryNavigation() {
  const nav = document.querySelector("aside > nav");
  return {
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    buttons: [...nav.querySelectorAll("button")].map((button) => {
      const r = button.getBoundingClientRect(),
        style = getComputedStyle(button);
      return {
        name: (button.getAttribute("aria-label") ?? button.textContent)
          .replace(/\s+/g, " ")
          .trim(),
        page: button.dataset.page,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        visible: style.display !== "none" && style.visibility !== "hidden",
        reachable: !button.disabled && button.tabIndex >= 0,
      };
    }),
  };
}
export function assertPrimaryNavigation(metrics) {
  assert.ok(
    metrics.documentWidth <= metrics.viewport.width + 1,
    `Horizontal overflow: ${metrics.documentWidth} > ${metrics.viewport.width}`,
  );
  assert.deepEqual(
    metrics.buttons.map((b) => b.page),
    ["inbox", "work", "memory", "connections"],
  );
  for (const button of metrics.buttons) {
    assert.ok(
      button.name && button.visible && button.reachable,
      `Inaccessible destination: ${button.page}`,
    );
    assert.ok(
      button.x >= -1 && button.x + button.width <= metrics.viewport.width + 1,
      `Clipped destination: ${button.page}`,
    );
    assert.ok(
      button.y >= -1 && button.y + button.height <= metrics.viewport.height + 1,
      `Offscreen destination: ${button.page}`,
    );
    assert.ok(
      button.width >= 44 && button.height >= 44,
      `Small touch target: ${button.page}`,
    );
  }
}

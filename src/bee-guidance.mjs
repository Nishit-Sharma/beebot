import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const pins = {
  "bee.outcomes": {
    version: "1.2.0",
    sha256: "b3074c356adc5870a2777a24cb15616154383784d1487d5fa9d5f504483a8d91",
  },
  "bee.evidence": {
    version: "1.1.0",
    sha256: "60b67d67d21c9f8c10d17f4c3f9cda24e22756e4241b76d85e25ff6fa251f393",
  },
  "bee.drafting": {
    version: "1.2.0",
    sha256: "5588d7246d0f77b355b2fd788baa890d03961edf094b27133d1308b9aa24b2ee",
  },
  "bee.ui-review": {
    version: "1.1.0",
    sha256: "60654beaa21c6cd70d103728833ee7b95ff11c5e52f91534622eefc53906f141",
  },
};
export const canonical = (value) => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};
export const guidanceHash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === expected.sort().join("|");
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export function validateGuidancePack(pack) {
  if (
    !keys(pack, ["id", "version", "modules"]) ||
    pack.id !== "bee.focused-guidance" ||
    pack.version !== "1.2.0" ||
    !Array.isArray(pack.modules) ||
    pack.modules.length !== 4
  )
    throw Error("InvalidGuidancePack");
  const seen = new Set();
  for (const module of pack.modules) {
    if (
      !keys(module, [
        "id",
        "version",
        "applicability",
        "dependencies",
        "capabilities",
        "provenance",
        "text",
        "sha256",
      ]) ||
      seen.has(module.id) ||
      !pins[module.id] ||
      !Array.isArray(module.dependencies) ||
      module.dependencies.some((d) => typeof d !== "string") ||
      !Array.isArray(module.capabilities) ||
      module.capabilities.length ||
      typeof module.text !== "string" ||
      Buffer.byteLength(module.text) > 2400 ||
      !module.text.trim()
    )
      throw Error("InvalidGuidanceModule");
    seen.add(module.id);
    const { sha256, ...body } = module;
    if (
      module.version !== pins[module.id].version ||
      sha256 !== pins[module.id].sha256 ||
      guidanceHash(body) !== sha256
    )
      throw Error("GuidanceIntegrityMismatch");
  }
  const modules = new Map(pack.modules.map((m) => [m.id, m]));
  const visit = (id, path = new Set()) => {
    const module = modules.get(id);
    if (!module || path.has(id))
      throw Error("GuidanceDependencyMissingOrCycle");
    for (const dependency of module.dependencies)
      visit(dependency, new Set([...path, id]));
  };
  modules.forEach((m) => visit(m.id));
  return freeze(structuredClone(pack));
}
export function loadGuidancePack() {
  const bytes = readFileSync(
    new URL("../guidance/bee-pack.json", import.meta.url),
  );
  if (bytes.length > 24000) throw Error("GuidanceRegistryBudgetExceeded");
  let pack;
  try {
    pack = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw Error("InvalidGuidanceJSON");
  }
  return validateGuidancePack(pack);
}
// Fixed internal registry only: no paths, scripts, host discovery or model-selected modules.
const registry = loadGuidancePack();
export function selectGuidance({ messages = [], intentChanges = [] } = {}) {
  const requests = messages.filter((m) => m.role === "user");
  const replaced = new Set(
    intentChanges
      .filter(
        (change) =>
          change.type === "replace-request" &&
          change.source === "owner-command" &&
          change.scope === "entire-message" &&
          typeof change.actor === "string" &&
          Number.isInteger(change.requestNumber) &&
          change.requestNumber >= 1 &&
          Number.isInteger(change.replacementRequestNumber) &&
          change.replacementRequestNumber > change.requestNumber &&
          change.replacementRequestNumber <= requests.length &&
          change.requestDigest ===
            createHash("sha256")
              .update(requests[change.requestNumber - 1].text)
              .digest("hex") &&
          change.replacementRequestDigest ===
            createHash("sha256")
              .update(requests[change.replacementRequestNumber - 1].text)
              .digest("hex"),
      )
      .map((change) => change.requestNumber),
  );
  const ownerText = requests
    .filter((_, index) => !replaced.has(index + 1))
    .map((m) => m.text)
    .join("\n");
  const wantsUI =
    /\b(ui|ux|frontend|interface|accessibility|screen reader|login form|webpage|web page)\b/i.test(
      ownerText,
    );
  const selected = registry.modules.filter(
    (m) =>
      m.applicability === "all-requests" ||
      (wantsUI && m.applicability === "ui-request"),
  );
  const resolved = [],
    seen = new Set();
  const add = (id) => {
    if (seen.has(id)) return;
    const module = registry.modules.find((m) => m.id === id);
    if (!module) throw Error("GuidanceDependencyMissing");
    module.dependencies.forEach(add);
    seen.add(id);
    resolved.push(module);
  };
  selected.forEach((m) => add(m.id));
  if (resolved.length > 4 || Buffer.byteLength(canonical(resolved)) > 14000)
    throw Error("GuidanceSelectionBudgetExceeded");
  return {
    packId: registry.id,
    packVersion: registry.version,
    packHash: guidanceHash(registry),
    modules: resolved,
  };
}

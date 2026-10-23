import { hash } from "./demo-runner.mjs";
const definitions = Object.freeze({
  "calendar.event": ["calendarId", "title", "start", "end", "timezone"],
  "message.send": ["recipientId", "body"],
  "publication.publish": ["targetId", "body"],
});
/** Inspectable future-write contracts. No credential handling or execution implementation is installed. */
export function validateExternalPlan(input, { owner, now = Date.now() } = {}) {
  if (
    !input ||
    input.owner !== owner ||
    !Object.hasOwn(definitions, input.capability) ||
    typeof input.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(input.idempotencyKey) ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= now ||
    input.expiresAt > now + 600000 ||
    typeof input.expectedStateVersion !== "string" ||
    !input.expectedStateVersion ||
    !Array.isArray(input.sourceRefs) ||
    input.sourceRefs.length > 10 ||
    input.sourceRefs.some((s) => typeof s !== "string")
  )
    throw Error("InvalidExternalPlan");
  const required = definitions[input.capability],
    p = input.parameters;
  if (
    !p ||
    Object.keys(p).some((k) => !required.includes(k)) ||
    required.some(
      (k) => typeof p[k] !== "string" || !p[k].trim() || p[k].length > 8000,
    )
  )
    throw Error("InvalidExternalParameters");
  if (
    input.capability === "calendar.event" &&
    (!Number.isFinite(Date.parse(p.start)) ||
      !Number.isFinite(Date.parse(p.end)) ||
      Date.parse(p.end) <= Date.parse(p.start))
  )
    throw Error("InvalidExternalTime");
  return {
    ...input,
    status: "unavailable",
    approvalDigest: hash(input),
    requires:
      "Connected adapter, verified target, exact owner approval and post-action reconciliation",
  };
}
export function createExternalAdapters() {
  return {
    list: () =>
      Object.keys(definitions).map((id) => ({
        id,
        enabled: false,
        requiredParameters: definitions[id],
        reason: "No connected adapter or write grant",
      })),
    plan: validateExternalPlan,
    execute() {
      throw Error("ExternalAdapterDisabled");
    },
    reconcile() {
      throw Error("ExternalAdapterDisabled");
    },
  };
}

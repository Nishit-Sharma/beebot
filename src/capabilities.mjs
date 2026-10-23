import { validateRecipe, generatedBaseline } from "./generated-policy.mjs";
import { verifyPrivateWork } from "./private-work.mjs";
import { hash } from "./demo-runner.mjs";
export const capabilities = Object.freeze([
  {
    id: "local.document",
    version: 2,
    available: true,
    title: "Draft a local document",
    scope:
      "Creates a reviewable text artifact in this task only. No messages, files or network writes.",
    approval: "prepare-within-request; review-result",
    reconciliation: "artifact digest",
  },
  {
    id: "local.checklist",
    version: 1,
    available: true,
    title: "Prepare a checklist with durable progress",
    scope:
      "Private checklist; owner marks progress. No external actions or inferred completion.",
    approval: "prepare-within-request; review-result",
    reconciliation: "artifact digest and owner progress events",
  },
  {
    id: "local.schedule",
    version: 1,
    available: true,
    title: "Prepare a checked time plan",
    scope:
      "Private time blocks checked for overlap and window bounds. No calendar writes.",
    approval: "prepare-within-request; review-result",
    reconciliation: "computed time constraints and artifact digest",
  },
  {
    id: "demo.policy",
    version: 1,
    available: true,
    title: "Test and propose an isolated policy fix",
    scope:
      "Generated declarative cases and pure expression only; isolated project, no network. Generated-policy demo from an intentionally unimplemented baseline; proposed cases are not independent correctness proof. Case confirmation, optional owner examples, then separate exact patch approval.",
    approval: "cases-then-patch",
    reconciliation: "source snapshot and actual test receipt",
  },
  {
    id: "calendar.event",
    version: 1,
    available: false,
    title: "Calendar event",
    scope: "No calendar connected",
  },
  {
    id: "message.send",
    version: 1,
    available: false,
    title: "Send a message",
    scope: "No messaging account connected",
  },
  {
    id: "web.research",
    version: 1,
    available: false,
    title: "Research the web",
    scope: "No browsing tool connected",
  },
]);
export const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "questions", "steps"],
  properties: {
    reply: { type: "string", maxLength: 4000 },
    questions: {
      type: "array",
      maxItems: 5,
      items: { type: "string", maxLength: 500 },
    },
    steps: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "capability", "content", "dependsOn"],
        properties: {
          id: { type: "string", maxLength: 40 },
          title: { type: "string", maxLength: 200 },
          capability: { type: "string", enum: capabilities.map((c) => c.id) },
          content: { type: "string", maxLength: 8000 },
          dependsOn: {
            type: "array",
            maxItems: 7,
            items: { type: "string", maxLength: 40 },
          },
        },
      },
    },
  },
};
export function validateProposal(p) {
  if (
    !p ||
    typeof p.reply !== "string" ||
    p.reply.length > 4000 ||
    !Array.isArray(p.questions) ||
    p.questions.length > 5 ||
    p.questions.some((q) => typeof q !== "string" || q.length > 500) ||
    !Array.isArray(p.steps) ||
    p.steps.length > 8
  )
    throw Error("InvalidProposal");
  const ids = new Set();
  let size = 0;
  for (const s of p.steps) {
    if (
      !s ||
      typeof s.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(s.id) ||
      ids.has(s.id) ||
      typeof s.title !== "string" ||
      s.title.length > 200 ||
      typeof s.content !== "string" ||
      s.content.length > 8000 ||
      !capabilities.some((c) => c.id === s.capability) ||
      !Array.isArray(s.dependsOn) ||
      s.dependsOn.some((d) => !ids.has(d))
    )
      throw Error("InvalidStep");
    ids.add(s.id);
    size += s.content.length;
  }
  if (size > 16000) throw Error("ProposalBudgetExceeded");
  if (
    p.questions.length &&
    p.steps.some(
      (step) =>
        !["local.document", "local.checklist"].includes(step.capability),
    )
  )
    throw Error("ClarifyBeforePlanning");
  return p;
}
export function scopedPlan(
  step,
  { conversationId, revision, memorySources, expiresAt, guidance = null },
) {
  const capability = capabilities.find((c) => c.id === step.capability);
  const plan = {
    ...step,
    conversationId,
    revision,
    capabilityVersion: capability.version,
    scope: capability.scope,
    memorySources,
    expiresAt,
    ...(guidance ? { guidance: structuredClone(guidance) } : {}),
  };
  if (["local.checklist", "local.schedule"].includes(step.capability))
    verifyPrivateWork(step.capability, step.content);
  if (step.capability === "demo.policy") {
    const recipe = validateRecipe(step.content);
    plan.recipe = recipe;
    plan.workspaceVersion = 2;
    plan.stage = "test";
    plan.sourceBefore = generatedBaseline;
    plan.sourceAfter = recipe.source;
  }
  return {
    ...plan,
    digest: hash(plan),
    status: capability.available ? "approval_required" : "unavailable",
  };
}

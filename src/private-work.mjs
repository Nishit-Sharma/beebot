import { interpretationHints } from "./interpretation-hints.mjs";
/** Domain-specific checks for reversible private preparation; no network/file/tool execution. */
const id = (x) =>
  typeof x === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(x);
const text = (x, n = 300) =>
  typeof x === "string" && x.trim().length > 0 && x.length <= n;
function minute(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw Error("InvalidPlanTime");
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}
export function verifyPrivateWork(capability, content) {
  if (capability === "local.document") {
    if (typeof content !== "string" || !content.trim())
      throw Error("EmptyPrivateDraft");
    return {
      kind: "document",
      checks: ["Private draft only; factual and semantic review required"],
      data: null,
    };
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw Error("InvalidPrivateWorkObject");
  }
  if (capability === "local.checklist") {
    if (
      !Array.isArray(data.items) ||
      !data.items.length ||
      data.items.length > 30
    )
      throw Error("InvalidChecklist");
    const ids = new Set();
    for (const item of data.items) {
      if (
        !id(item.id) ||
        ids.has(item.id) ||
        !text(item.text) ||
        item.done === true
      )
        throw Error("InvalidChecklistItem");
      ids.add(item.id);
    }
    return {
      kind: "checklist",
      data: { items: data.items.map(({ id, text }) => ({ id, text })) },
      checks: [
        "Unique actionable item identities",
        "No completion claimed before owner feedback",
        "Progress records owner reports, not independent execution proof",
      ],
    };
  }
  if (capability === "local.schedule") {
    const start = minute(data.window?.start),
      end = minute(data.window?.end);
    if (
      end <= start ||
      !Array.isArray(data.blocks) ||
      !data.blocks.length ||
      data.blocks.length > 24
    )
      throw Error("InvalidTimePlan");
    const ids = new Set();
    const blocks = data.blocks
      .map((block) => {
        if (!id(block.id) || ids.has(block.id) || !text(block.title, 200))
          throw Error("InvalidTimeBlock");
        ids.add(block.id);
        const from = minute(block.start),
          to = minute(block.end);
        if (to <= from || from < start || to > end)
          throw Error("TimeBlockOutsideWindow");
        return { ...block, minutes: to - from };
      })
      .sort((a, b) => minute(a.start) - minute(b.start));
    for (let i = 1; i < blocks.length; i++)
      if (minute(blocks[i].start) < minute(blocks[i - 1].end))
        throw Error("OverlappingTimeBlocks");
    const unscheduled = data.unscheduled ?? [];
    if (
      !Array.isArray(unscheduled) ||
      unscheduled.length > 20 ||
      unscheduled.some((x) => !text(x, 500))
    )
      throw Error("InvalidUnscheduledItems");
    return {
      kind: "schedule",
      data: { window: data.window, blocks, unscheduled },
      checks: [
        "All time blocks inside the proposed window",
        "No overlapping blocks",
        "Positive durations; " +
          blocks.reduce((n, b) => n + b.minutes, 0) +
          " minutes scheduled",
        "Private time plan only; calendar unchanged; verify task coverage and constraints",
      ],
    };
  }
  throw Error("UnsupportedPrivatePreparation");
}
export function preparePrivateArtifacts(
  conversation,
  { now, id, hash, event },
) {
  for (const step of conversation.steps) {
    if (
      !["local.document", "local.checklist", "local.schedule"].includes(
        step.capability,
      ) ||
      step.status !== "approval_required" ||
      step.dependsOn.some(
        (dependency) =>
          !conversation.steps.some(
            (s) => s.id === dependency && s.status === "completed",
          ),
      )
    )
      continue;
    const verification = verifyPrivateWork(step.capability, step.content);
    const artifact = {
      id: id(),
      stepId: step.id,
      title: step.title,
      content: step.content,
      digest: hash(step.content),
      plan: structuredClone(step),
      preparedBy: "companion",
      authority: "requested-safe-preparation",
      ownerApproved: false,
      provisional: conversation.pendingQuestion?.state === "pending",
      verification,
      progress: {},
      at: now(),
    };
    conversation.artifacts.push(artifact);
    step.status = "completed";
    step.receipt = {
      artifactId: artifact.id,
      digest: artifact.digest,
      verification,
    };
    event(
      conversation,
      "prepared",
      "Private " +
        verification.kind +
        " prepared within the request; no external action. Review before use.",
    );
  }
}
export function progressContext(conversation) {
  return conversation.artifacts.map((a) => ({
    id: a.id,
    title: a.title,
    revision: a.plan?.revision,
    digest: a.digest,
    content: a.content,
    preparedAt: a.at,
    provisional: a.provisional === true,
    kind: a.verification?.kind ?? "document",
    schedule:
      a.verification?.kind === "schedule" ? a.verification.data : undefined,
    items:
      a.verification?.kind === "checklist"
        ? a.verification.data.items.map((item) => ({
            id: item.id,
            text: item.text,
            ownerMarkedDone: a.progress?.[item.id]?.done === true,
          }))
        : undefined,
  }));
}

/** Shared serialized provider input: reject excess context rather than omit it. */
export function providerEnvelope({
  messages,
  memory,
  artifacts = [],
  intentChanges = [],
  privatePreparationReview = null,
}) {
  return {
    conversation: messages,
    savedContext: memory,
    existingArtifacts: artifacts,
    intentChanges,
    interpretationHints: interpretationHints({ messages, memory }),
    ...(privatePreparationReview ? { privatePreparationReview } : {}),
  };
}

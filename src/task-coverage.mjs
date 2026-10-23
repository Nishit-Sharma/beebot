import { hash } from "./demo-runner.mjs";
/** Conversation history is retained context unless an exact owner command records replacement. */
export function taskCoverage(conversations) {
  return conversations.flatMap((c) => {
    const requests = c.messages.filter((m) => m.role === "user");
    const replaced = new Map();
    for (const change of c.intentChanges ?? []) {
      const target = requests[change.requestNumber - 1];
      if (
        change.type === "replace-request" &&
        change.source === "owner-command" &&
        change.actor === c.owner &&
        change.scope === "entire-message" &&
        target &&
        change.requestDigest === hash(target.text) &&
        change.replacementRequestNumber > change.requestNumber &&
        change.replacementRequestNumber <= requests.length
      )
        replaced.set(change.requestNumber, change);
    }
    const activeContext = requests
      .filter((_, index) => !replaced.has(index + 1))
      .map((m) => m.text);
    const objective = activeContext[0] ?? requests.at(-1)?.text ?? "";
    return requests.map((request, index) => {
      const current = index === requests.length - 1;
      const replacement = replaced.get(index + 1);
      const evidence = (c.actionEvidence ?? []).filter(
        (e) => e.revision === c.revision,
      );
      const ownerProgress = c.artifacts
        .filter((a) => a.verification?.kind === "checklist")
        .map((a) => ({
          artifactId: a.id,
          done: a.verification.data.items.filter(
            (i) => a.progress?.[i.id]?.done,
          ).length,
          total: a.verification.data.items.length,
        }));
      let state;
      if (replacement) state = "superseded";
      else if (!current) state = "retained-context";
      else if (c.status === "completed")
        state = evidence.some((e) => e.exitCode === 0)
          ? "verified"
          : "reviewed";
      else if (["cancelled", "cancelling"].includes(c.status))
        state = "canceled";
      else if (["waiting_source", "waiting_source_action"].includes(c.status))
        state = "waiting-for-source";
      else if (["failed", "source_changed", "interrupted"].includes(c.status))
        state = "blocked";
      else if (c.status === "clarifying") state = "needs-input";
      else if (c.status === "plan_review") state = "needs-approval";
      else if (c.status === "paused" || c.status === "pausing")
        state = "paused";
      else if (c.status === "review_required") state = "ready-for-review";
      else state = "working";
      return {
        conversationId: c.id,
        requestNumber: index + 1,
        request: request.text,
        objective,
        activeContext,
        current,
        state,
        scope: c.mode === "fixture" ? "simulated" : "model-assisted",
        evidence: evidence.map((e) => ({
          exitCode: e.exitCode,
          outputHash: e.outputHash,
          sourceHash: e.sourceHash,
        })),
        artifacts: c.artifacts.length,
        ownerProgress,
        note:
          state === "waiting-for-source"
            ? "Waiting for a fresh selected Bee source before inference or execution; no active progress or automatic replay is implied."
            : state === "superseded"
              ? "Owner explicitly replaced this exact entire message with request " +
                replacement.replacementRequestNumber +
                ". Other retained context is unchanged."
              : state === "retained-context"
                ? "Retained owner context: clarification, additions and progress do not automatically cancel earlier objectives or constraints."
                : state === "verified"
                  ? "Owner accepted and current-revision sandbox checks passed; semantic completeness still depends on acceptance coverage."
                  : state === "reviewed"
                    ? "Owner accepted a prepared result; independent execution proof is not implied."
                    : "",
      };
    });
  });
}

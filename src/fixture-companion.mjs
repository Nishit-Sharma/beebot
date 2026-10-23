/** Explicit deterministic replay, never selected as a real model fallback. */
export const fixtureTurns = [
  {
    reply:
      "I can draft a focused plan using what you tell me. What is the event, duration and audience?",
    questions: ["What is the event, duration and audience?"],
    steps: [],
  },
  {
    reply:
      "Here is a two-part plan for your review. These are local drafts; nothing is booked or sent.",
    questions: [],
    steps: [
      {
        id: "agenda",
        title: "Workshop agenda",
        capability: "local.document",
        content:
          "45-minute beginner workshop\n0–5: Introductions and goals\n5–15: Demonstration\n15–30: Guided practice in pairs\n30–40: Independent exercise\n40–45: Questions and next steps",
        dependsOn: [],
      },
      {
        id: "checklist",
        title: "Facilitator checklist",
        capability: "local.document",
        content:
          "Before: confirm accessible room, prepare example and exercise, test display.\nDuring: state learning goal, check understanding after demonstration, offer help during practice.\nAfter: collect one question and one takeaway.\nRoom booking and invitations require separate connected tools, which are unavailable.",
        dependsOn: ["agenda"],
      },
    ],
  },
];
export async function fixtureCompanion({
  fixtureKind,
  messages,
  onDelta = () => {},
  signal,
}) {
  if (signal?.aborted) throw Error("Interrupted");
  const result = structuredClone(
    (fixtureKind === "policy" ? policyTurns : fixtureTurns)[
      Math.min(messages.filter((m) => m.role === "user").length - 1, 1)
    ],
  );
  for (const chunk of JSON.stringify(result).match(/.{1,80}/gs) ?? []) {
    if (signal?.aborted) throw Error("Interrupted");
    onDelta(chunk);
    await new Promise((r) => setImmediate(r));
  }
  return result;
}

const policyTurns = [
  {
    reply:
      "Should the 10% discount start at a cart total of exactly 100, with totals below 100 unchanged? Confirm those acceptance conditions before I propose tests.",
    questions: ["Confirm threshold inclusion and unchanged lower totals."],
    steps: [],
  },
  {
    reply:
      "I propose three acceptance cases and a pure discount rule. Approve the test first; if it fails, inspect and approve the exact generated patch separately.",
    questions: [],
    steps: [
      {
        id: "discount",
        title: "10% discount at the threshold",
        capability: "demo.policy",
        dependsOn: [],
        content: JSON.stringify({
          cases: [
            {
              name: "below threshold stays unchanged",
              input: { total: 90 },
              expected: 90,
            },
            {
              name: "exactly 100 gets discount",
              input: { total: 100 },
              expected: 90,
            },
            {
              name: "above threshold gets discount",
              input: { total: 200 },
              expected: 180,
            },
          ],
          expression: {
            op: "if",
            args: [
              { op: "gte", args: [{ field: "total" }, { value: 100 }] },
              { op: "multiply", args: [{ field: "total" }, { value: 0.9 }] },
              { field: "total" },
            ],
          },
        }),
      },
    ],
  },
];

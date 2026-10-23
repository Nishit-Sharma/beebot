/** Narrow reversible interpretation advice. Never edits source or grants authority. */
export function interpretationHints({ messages = [], memory = [] }) {
  const ownerText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join("\n");
  if (
    /do not correct|keep (?:the )?exact wording|literal(?:ly)? imaginary plan/i.test(
      ownerText,
    )
  )
    return [];
  const context = [
    ...messages.map((m) => m.text),
    ...memory.map((m) => m.text),
  ].join("\n");
  if (
    !/house\s*plants?/i.test(context) ||
    !/\bworkshop\b/i.test(context) ||
    !/\bactivity\b/i.test(context) ||
    !/\bimaginary plan\b/i.test(context)
  )
    return [];
  return [
    {
      kind: "low-risk-transcription-assumption",
      rawPhrase: "imaginary plan",
      interpretation: "imaginary plant",
      reason:
        "The selected task is a houseplant workshop with an imagined activity.",
      scope:
        "Reversible private preparation only. Preserve raw wording and independent constraints; names, dates, amounts, recipients and permissions are not corrected by this rule.",
      grantsAuthority: false,
    },
  ];
}

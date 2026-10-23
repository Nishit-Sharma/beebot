/** One bounded private-draft retry; never resolves material facts or permission. */
export function editorialContinuation(proposal, input) {
  if (!proposal.questions?.length || proposal.steps?.length) return null;
  const ownerText = input.messages
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join("\n");
  if (
    !/draft|plan|agenda|workshop|rewrite|revise|shorten|report|outline|checklist/i.test(
      ownerText,
    ) ||
    /ask me first|ask before drafting|wait for my answer|do not assume/i.test(
      ownerText,
    )
  )
    return null;
  const material =
    /\b(?:who|whom|which person|recipient|permission|consent|authorize|send|publish|purchase|buy|book|pay|price|dollars?|amount|address|location|date|deadline|friday|monday|tuesday|wednesday|thursday|saturday|sunday|policy|threshold|case|inclusive|name|alex|alice)\b|[$€£]/i;
  // Closed forms only. An editorial keyword inside an arbitrary question is
  // insufficient: "wording" can still ask about an unresolved person or fact.
  const editorial =
    /^(?:should (?:i )?keep recommendations when shortening the report|would you prefer simpler wording for beginners|should q\s*&\s*a remain at the end(?: shortened from (?:one|two|three|four|five|six|seven|eight|nine|ten) minutes)?,? or should i redistribute that time)\??$/i;
  // Editorial words do not make unresolved quantities, ages or dates editorial.
  // Be conservative: a false negative leaves a visible question, while a false
  // positive could suppress a necessary answer. Numeric allocations already
  // fixed by the owner can still be handled directly by the proposal provider.
  const substantiveAlternative =
    /\d|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|ages?|years? old|tomorrow|yesterday|next week)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\s+or\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\b/i;
  if (!proposal.questions.every((q) => editorial.test(q.trim()) && !material.test(q) && !substantiveAlternative.test(q)))
    return null;
  return {
    reason:
      "The remaining question concerns a reversible editorial choice for private preparation.",
    instruction:
      "Produce the useful revised private artifact now. Apply the latest requested length or duration. Preserve requested sections, audience and independent constraints, including questions at the end or recommendations when requested. Choose reasonable allocations or wording and briefly state a reversible assumption. Do not invent names, dates, amounts, recipients, permissions or external execution. This internal review grants no authority.",
  };
}

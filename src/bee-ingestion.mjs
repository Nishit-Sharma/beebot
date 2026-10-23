/** Documented Bee stream decoder. No account, device or model is contacted. */
export function decodeBeeLine(
  line,
  { session, sequence, receivedAt, simulated = false, recovered = false },
) {
  if (typeof line !== "string" || Buffer.byteLength(line) > 65536)
    throw new Error("Invalid or oversized Bee payload");
  if (
    typeof session !== "string" ||
    !session ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Number.isFinite(Date.parse(receivedAt))
  )
    throw new Error("Invalid receiver identity");
  const data = JSON.parse(line);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Expected Bee object");
  if (!Object.hasOwn(data, "utterance")) return null; // Other documented events are not utterances.
  if (
    !data.utterance ||
    typeof data.utterance !== "object" ||
    typeof data.utterance.text !== "string" ||
    !data.utterance.text.trim() ||
    typeof data.utterance.speaker !== "string" ||
    typeof data.conversation_uuid !== "string" ||
    !data.conversation_uuid
  )
    throw new Error("Invalid Bee utterance");
  return Object.freeze({
    version: 1,
    source: "bee",
    receiverSession: session,
    sequence,
    receivedAt,
    providerReference: data.conversation_uuid,
    text: data.utterance.text,
    speaker: data.utterance.speaker,
    simulated,
    recovered,
    authorized: false,
  });
}

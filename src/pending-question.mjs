import { randomUUID, randomInt } from "node:crypto";
import { hash } from "./demo-runner.mjs";

/** Correlation only. A token never grants model-sharing or execution authority. */
export function issuePendingQuestion(conversation, questions, now) {
  return {
    id: randomUUID(),
    conversationId: conversation.id,
    revision: conversation.revision,
    token: "BEE-" + randomInt(100000, 1000000),
    questions: [...questions],
    questionDigest: hash(questions),
    sourceBinding: hash(conversation.memorySources),
    issuedAt: now,
    expiresAt: now + 3600000,
    state: "pending",
    delivery: "not-connected",
  };
}

export function validateSelectedReply(conversation, input, source, now) {
  const question = conversation.pendingQuestion;
  if (
    conversation.status !== "clarifying" ||
    !question ||
    question.state !== "pending" ||
    question.conversationId !== conversation.id ||
    question.revision !== conversation.revision
  )
    throw Error("PendingQuestionUnavailable");
  if (question.expiresAt <= now) throw Error("PendingQuestionExpired");
  if (question.sourceBinding !== hash(conversation.memorySources))
    throw Error("PendingQuestionSourceChanged");
  if (input.questionId !== question.id || input.replyToken !== question.token)
    throw Error("PendingQuestionMismatch");
  if (
    input.confirmed !== true ||
    (conversation.mode !== "fixture" &&
      input.providerConsent !== "codex-openai")
  )
    throw Error("SelectedBeeReplyConsentRequired");
  if (
    !source ||
    source.deleted ||
    source.kind !== "conversation" ||
    !/^conversation:\d+$/.test(source.reference) ||
    source.id !== input.sourceId ||
    source.revision !== input.sourceRevision ||
    source.contextDigest !== input.contextDigest ||
    typeof source.text !== "string" ||
    !source.text.trim() ||
    Buffer.byteLength(source.text) > 8192 ||
    (source.simulated && conversation.mode !== "fixture")
  )
    throw Error("SelectedBeeReplySourceChanged");
  const tokens = [...source.text.matchAll(/\bBEE-\d{6}\b/gi)].map((m) =>
    m[0].toUpperCase(),
  );
  if (new Set(tokens).size !== 1 || tokens[0] !== question.token)
    throw Error("SelectedBeeReplyAmbiguousToken");
  return {
    text: source.text,
    memoryId: "bee:" + source.id,
    provenance: {
      questionId: question.id,
      questionDigest: question.questionDigest,
      sourceId: source.id,
      sourceRevision: source.revision,
      reference: source.reference,
      contextDigest: source.contextDigest,
      token: question.token,
      confirmedAt: now,
    },
  };
}

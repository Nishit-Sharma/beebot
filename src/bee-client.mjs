import { createBeeClient } from "@beeai/cli/lib";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { decodeBeeLine } from "./bee-ingestion.mjs";
export function createBeeSourceClient({
  client = createBeeClient({
    command: process.execPath,
    baseArgs: [fileURLToPath(new URL("./bee-command.mjs", import.meta.url))],
  }),
  onCapture = () => {},
  onDelete = () => {},
  selectedConversations = () => [],
} = {}) {
  let active = null,
    state = { connected: false, started: false, gap: false, error: null };
  return {
    status: () => ({ ...state }),
    async listRecentConversations() {
      const data = await client.api.conversations.list({ limit: 5 });
      if (!Array.isArray(data?.conversations))
        throw Error("InvalidBeeConversationList");
      return data.conversations
        .slice(0, 5)
        .map((c) => ({
          id: String(c.id),
          title:
            typeof c.title === "string"
              ? c.title.slice(0, 200)
              : typeof c.short_summary === "string"
                ? c.short_summary.slice(0, 200)
                : "Untitled Bee conversation",
          startTime: c.start_time ?? null,
          state: typeof c.state === "string" ? c.state : "UNKNOWN",
        }))
        .filter((c) => /^\d{1,20}$/.test(c.id));
    },
    async readConversation(id) {
      if (!/^\d{1,20}$/.test(String(id)))
        throw Error("InvalidBeeConversationId");
      const data = await client.api.conversations.get(id);
      const record = data?.conversation ?? data;
      if (record?.state !== "COMPLETED")
        throw Error("Bee is still processing this conversation.");
      const text = conversationText(record);
      if (record?.id !== undefined && String(record.id) !== String(id))
        throw Error("BeeConversationIdentityMismatch");
      return {
        transcriptDigest: createHash("sha256")
          .update(JSON.stringify(transcriptUtterances(record)))
          .digest("hex"),
        conversationId: String(id),
        conversationUuid: typeof record?.uuid === "string" ? record.uuid : null,
        reference: "conversation:" + id,
        text,
        kind: "conversation",
        transport: "official-cli-library",
        recovered: true,
        simulated: false,
      };
    },
    start() {
      if (active) return;
      if (
        !selectedConversations().some(
          (s) => s.conversationId && s.conversationUuid,
        )
      )
        throw Error("SelectAndFollowMappedBeeConversationFirst");
      const session = randomUUID(),
        stream = client.sse.streamJson({
          types: ["new-utterance", "delete-conversation"],
        });
      active = stream;
      state = { ...state, started: true, error: null };
      let sequence = 0;
      (async () => {
        try {
          for await (const event of stream.events) {
            if (active !== stream) return;
            const data = event.data;
            const scopes = selectedConversations();
            if (!scopes.some((s) => s.conversationId && s.conversationUuid)) {
              stream.close();
              break;
            }
            if (data?.conversation && !data.utterance) {
              const deleted = data.conversation;
              const selected = scopes.find(
                (s) =>
                  (deleted.id !== undefined &&
                    s.conversationId != null &&
                    String(s.conversationId) === String(deleted.id)) ||
                  (typeof deleted.uuid === "string" &&
                    typeof s.conversationUuid === "string" &&
                    s.conversationUuid === deleted.uuid),
              );
              if (selected)
                onDelete({
                  conversationId: selected.conversationId,
                  conversationUuid: selected.conversationUuid,
                });
              continue;
            }
            const selected = scopes.find(
              (s) =>
                typeof data?.conversation_uuid === "string" &&
                typeof s.conversationUuid === "string" &&
                s.conversationUuid === data.conversation_uuid,
            );
            if (!selected) continue;
            const capture = decodeBeeLine(JSON.stringify(data), {
              session,
              sequence: sequence++,
              receivedAt: new Date().toISOString(),
            });
            if (capture) {
              state = { ...state, connected: true };
              await onCapture({
                ...capture,
                conversationId: selected.conversationId,
                conversationUuid: selected.conversationUuid,
                id: session + ":" + capture.sequence,
              });
            }
          }
        } catch {
          if (active === stream)
            state.error =
              "Bee stream unavailable; check Developer Mode and existing login";
        } finally {
          if (active === stream) {
            active = null;
            state = { ...state, connected: false, started: false, gap: true };
          }
        }
      })();
    },
    stop() {
      const old = active;
      active = null;
      old?.close();
      state = { ...state, connected: false, started: false, gap: true };
    },
  };
}

export function transcriptUtterances(record) {
  return (Array.isArray(record?.transcriptions) ? record.transcriptions : [])
    .flatMap((t) => (Array.isArray(t?.utterances) ? t.utterances : []))
    .filter((u) => typeof u?.text === "string" && u.text.trim())
    .map((u) => u.text.trim());
}
export function conversationText(record) {
  const utterances = transcriptUtterances(record);
  const summary =
    typeof record?.short_summary === "string"
      ? record.short_summary.trim()
      : "";
  if (!summary && !utterances.length)
    throw Error(
      "BeeConversationNotProcessed: no recognized summary or transcript yet",
    );
  const bounded = (s, n) => {
    let result = "";
    for (const ch of s) {
      if (Buffer.byteLength(result + ch) > n) break;
      result += ch;
    }
    return result;
  };
  const head = [
    bounded(typeof record?.title === "string" ? record.title.trim() : "", 512),
    summary ? "Bee summary: " + bounded(summary, 2048) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const recent = [];
  let size = Buffer.byteLength(head) + 200;
  for (let i = utterances.length - 1; i >= 0; i--) {
    const text = utterances[i];
    if (size + Buffer.byteLength(text) + 1 > 12000) break;
    recent.unshift(text);
    size += Buffer.byteLength(text) + 1;
  }
  const omitted = utterances.length - recent.length;
  return [
    head,
    omitted ? "[Earlier transcript trimmed: " + omitted + " utterances]" : "",
    recent.length
      ? "ASR transcript; may contain recognition errors:\n" + recent.join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

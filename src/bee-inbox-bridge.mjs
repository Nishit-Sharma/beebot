/** Stream signals refresh a selected numeric parent; speech itself never starts work. */
export function createBeeInboxBridge({ bee, inbox }) {
  const pending = new Map();
  async function capture(event) {
    const id = String(event.conversationId);
    if (!/^\d{1,20}$/.test(id)) throw Error("InvalidBeeConversationId");
    if (pending.has(id)) return pending.get(id);
    const read = (async () => inbox.ingest(await bee.readConversation(id)))();
    pending.set(id, read);
    try {
      return await read;
    } finally {
      pending.delete(id);
    }
  }
  return { capture };
}

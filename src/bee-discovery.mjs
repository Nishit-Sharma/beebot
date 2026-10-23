/** Read-only inbox discovery. No task/model dependency exists at this boundary. */
export async function discoverBeeConversations({ bee, inbox }) {
  const seen = new Set(
    inbox.list({ includeDeleted: true }).map((s) => s.conversationId),
  );
  let added = 0,
    pending = 0;
  for (const row of await bee.listRecentConversations()) {
    if (seen.has(String(row.id))) continue;
    try {
      inbox.ingest({
        ...(await bee.readConversation(row.id)),
        discovered: true,
      });
      seen.add(String(row.id));
      added++;
    } catch {
      pending++;
    }
  }
  return { added, pending };
}

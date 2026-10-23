export function allowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
export function allowedOrigin(origin, host, port) {
  return allowedHost(host, port) && origin === `http://${host}`;
}
export function createProviderStatusCache({
  provider,
  clock = Date.now,
  ttlMs = 10000,
  timeoutMs = 2000,
}) {
  let saved = null,
    expires = 0,
    inflight = null;
  return async () => {
    if (saved && clock() < expires) return saved;
    if (inflight) return inflight;
    inflight = (async () => {
      let timer;
      try {
        saved = await Promise.race([
          provider.status(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (provider.reset) void provider.reset();
              else provider.close();
              reject(Error("ProviderStatusTimeout"));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        saved = {
          connected: false,
          error: String(error.message ?? error).slice(0, 300),
        };
      } finally {
        clearTimeout(timer);
        expires = clock() + ttlMs;
      }
      return saved;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
export async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65536) throw Error("PayloadTooLarge");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
export function httpErrorStatus(error) {
  if (error instanceof SyntaxError) return 400;
  return /^(Invalid|Unsupported|Explicit|Selected|Source|Conversation|Stale|Approval|Unauthorized|Memory|ReviewFirst|WaitFor|PayloadTooLarge|Idempotency|Capture|Bee is still processing|BeeConversation|SelectAndFollow|RequiredModel|ConnectChatGPT|UnreviewedInstruction|ReviewedGuidance)/.test(
    String(error.message ?? error),
  )
    ? 400
    : 500;
}

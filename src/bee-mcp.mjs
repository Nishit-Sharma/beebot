import { beeBinary } from "./runtime-paths.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
/** Local stdio MCP, no persistent registration, login, token access or model connection. */
export const BEE_READ_TOOLS = new Set([
  "bee_status",
  "bee_list_conversations",
  "bee_get_conversation",
  "bee_get_conversation_transcript",
  "bee_list_voice_notes",
  "bee_get_voice_note",
  "bee_list_todos",
  "bee_get_daily_summary",
]);
export function createBeeMcp({ spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  let process = null,
    next = 0,
    pending = new Map(),
    tools = [],
    ready = false,
    authenticated = false;
  const fail = (e) => {
    ready = false;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
  };
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!process) return reject(Error("BeeMcpNotConnected"));
      const id = ++next,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("BeeMcpTimeout"));
          close();
        }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      process.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  function close() {
    const old = process;
    process = null;
    old?.kill();
    fail(Error("BeeMcpClosed"));
  }
  async function localAuthStatus() {
    const result = await request("tools/call", {
      name: "bee_status",
      arguments: {},
    });
    try {
      authenticated =
        JSON.parse(result.content?.find((c) => c.type === "text")?.text ?? "{}")
          .connected === true;
    } catch {
      authenticated = false;
    }
  }
  async function connect() {
    if (ready) {
      await localAuthStatus();
      return status();
    }
    if (process) throw Error("BeeMcpConnecting");
    let buffer = Buffer.alloc(0);
    const child = spawnProcess(beeBinary(), ["mcp", "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    process = child;
    child.stderr.on("data", () => {});
    child.on("error", () => {
      if (process === child) process = null;
      fail(Error("BeeCliUnavailableOrNotLoggedIn"));
    });
    child.on("exit", () => {
      if (process === child) {
        process = null;
        fail(Error("BeeMcpExited"));
      }
    });
    child.stdout.on("data", (chunk) => {
      if (process !== child) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) {
        close();
        return;
      }
      let n;
      while ((n = buffer.indexOf(10)) >= 0) {
        const raw = buffer.subarray(0, n);
        buffer = buffer.subarray(n + 1);
        if (!raw.length) continue;
        try {
          const msg = JSON.parse(raw);
          if (msg.method && msg.id !== undefined) {
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: "Host requests unsupported" },
              }) + "\n",
            );
            continue;
          }
          const p = pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(msg.id);
            msg.error
              ? p.reject(Error("BeeMcpRequestFailed"))
              : p.resolve(msg.result);
          }
        } catch {
          close();
        }
      }
    });
    await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "bee-action-review", version: "0.1.0" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    tools = [];
    let cursor,
      pages = 0;
    do {
      const result = await request("tools/list", cursor ? { cursor } : {});
      tools.push(
        ...(result.tools ?? [])
          .filter((t) => BEE_READ_TOOLS.has(t.name))
          .map((t) => ({ name: t.name, inputSchema: t.inputSchema })),
      );
      cursor = result.nextCursor;
      if (++pages > 10) throw Error("BeeCatalogBudget");
    } while (cursor);
    ready = true;
    await localAuthStatus();
    return status();
  }
  function status() {
    return {
      connected: ready,
      authenticated,
      transport: "local-stdio",
      tools: ready ? tools : [],
      deviceCaptureVerified: false,
    };
  }
  async function read(name, args) {
    if (!ready || !BEE_READ_TOOLS.has(name))
      throw Error("BeeReadToolUnavailable");
    const tool = tools.find((t) => t.name === name);
    if (
      !tool ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).some(
        (k) => !Object.hasOwn(tool.inputSchema?.properties ?? {}, k),
      ) ||
      (tool.inputSchema?.required ?? []).some((k) => !Object.hasOwn(args, k))
    )
      throw Error("BeeToolArgumentsInvalid");
    const result = await request("tools/call", { name, arguments: args });
    if (result.isError) throw Error("BeeToolReadFailed");
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!text.trim() || Buffer.byteLength(text) > 32000)
      throw Error("BeeContextBudgetExceeded");
    return text;
  }
  return { connect, status, read, close };
}

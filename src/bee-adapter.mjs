import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { decodeBeeLine } from "./bee-ingestion.mjs";
/** Documented Bee CLI transport. Frames are bounded before assembly; speech is context only. */
export function createBeeAdapter({
  spawnProcess = spawn,
  onCapture = () => {},
  onStatus = () => {},
} = {}) {
  let child = null;
  let state = {
    connected: false,
    started: false,
    gap: false,
    lastReceivedAt: null,
    error: null,
  };
  const status = () => onStatus({ ...state });
  return {
    status: () => ({ ...state }),
    start() {
      if (child) return;
      const session = randomUUID();
      let sequence = 0,
        pending = Buffer.alloc(0),
        discard = false;
      const current = spawnProcess(
        "bee",
        ["stream", "--types", "new-utterance", "--json"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child = current;
      state = { ...state, started: true, error: null };
      const rejectFrame = () => {
        pending = Buffer.alloc(0);
        discard = true;
        state.error = "Oversized Bee frame rejected before buffering";
        status();
      };
      const line = (bytes) => {
        if (!bytes.length) return;
        try {
          const e = decodeBeeLine(bytes.toString("utf8"), {
            session,
            sequence: sequence++,
            receivedAt: new Date().toISOString(),
          });
          if (e) {
            state = { ...state, connected: true, lastReceivedAt: e.receivedAt };
            onCapture({ ...e, id: session + ":" + e.sequence });
            status();
          }
        } catch {
          state.error = "Invalid Bee event rejected";
          status();
        }
      };
      current.stdout.on("data", (chunk) => {
        if (child !== current) return;
        let start = 0;
        for (let i = 0; i <= chunk.length; i++) {
          if (i !== chunk.length && chunk[i] !== 10) continue;
          const part = chunk.subarray(start, i);
          if (!discard) {
            if (pending.length + part.length > 65536) rejectFrame();
            else pending = Buffer.concat([pending, part]);
          }
          if (i < chunk.length) {
            if (!discard) line(pending);
            pending = Buffer.alloc(0);
            discard = false;
          }
          start = i + 1;
        }
      });
      current.stderr.on("data", () => {});
      current.on("error", () => {
        if (child !== current) return;
        state = {
          ...state,
          connected: false,
          started: false,
          gap: true,
          error:
            "Bee CLI unavailable or failed. No credentials were inspected.",
        };
        child = null;
        status();
      });
      current.on("exit", () => {
        if (child !== current) return;
        state = { ...state, connected: false, started: false, gap: true };
        child = null;
        status();
      });
      status();
    },
    stop() {
      const old = child;
      child = null;
      old?.kill();
      if (old) {
        const timer = setTimeout(() => old.kill("SIGKILL"), 5000);
        timer.unref();
        old.once("exit", () => clearTimeout(timer));
      }
      state = { ...state, connected: false, started: false, gap: true };
      status();
    },
  };
}

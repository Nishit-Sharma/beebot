import { beeBinary } from "./runtime-paths.mjs";
/** Bounded launcher for the official Bee Node wrapper. No shell or auth commands. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const allowed =
  (args.length === 1 && args[0] === "version") ||
  (args[0] === "conversations" &&
    args[1] === "get" &&
    /^\d{1,20}$/.test(args[2] ?? "") &&
    args[3] === "--json" &&
    args.length === 4) ||
  (args[0] === "conversations" &&
    args[1] === "list" &&
    args[2] === "--limit" &&
    args[3] === "5" &&
    args[4] === "--json" &&
    args.length === 5) ||
  (args[0] === "stream" &&
    args[1] === "--json" &&
    args[2] === "--types" &&
    args[3] === "new-utterance,delete-conversation" &&
    args.length === 4);
if (!allowed) {
  process.stderr.write("Bee command outside the approved read scope\n");
  process.exit(2);
}
const binary = beeBinary();
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"].includes(k),
  ),
);
const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
let bytes = 0,
  stopping = false;
const live = args[0] === "stream";
let lineBytes = 0;
const stop = () => {
  if (stopping) return;
  stopping = true;
  child.kill();
  setTimeout(() => child.kill("SIGKILL"), 500).unref();
};
const timer = live ? null : setTimeout(stop, 15000);
child.stdout.on("data", (b) => {
  if (live) {
    for (const n of b) {
      lineBytes = n === 10 ? 0 : lineBytes + 1;
      if (lineBytes > 65536) {
        stop();
        return;
      }
    }
  } else {
    bytes += b.length;
    if (bytes > 1024 * 1024) {
      stop();
      return;
    }
  }
  if (!stopping) process.stdout.write(b);
});
child.stderr.on("data", () => {});
child.on("error", () => {
  process.stderr.write("Official Bee binary unavailable\n");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timer);
  if (stopping) process.stderr.write("Bee read stopped at resource boundary\n");
  else if (code)
    process.stderr.write(
      "Bee read unavailable; check Developer Mode and existing login\n",
    );
  process.exitCode = stopping ? 1 : (code ?? 1);
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

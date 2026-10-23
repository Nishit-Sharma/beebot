import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
export const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const baseline =
  "export function isDue(reminder, now) { return !reminder.completed && reminder.dueAt < now; }\n";
export function corrected(rule) {
  return `export function isDue(reminder, now) { return ${rule.excludeCompleted ? "!reminder.completed && " : ""}reminder.dueAt ${rule.inclusive ? "<=" : "<"} now; }\n`;
}
export function casesFor(rule) {
  return [
    {
      name: "open at due time",
      reminder: { completed: false, dueAt: 1000 },
      now: 1000,
      expected: rule.inclusive,
    },
    {
      name: "open before due time",
      reminder: { completed: false, dueAt: 1001 },
      now: 1000,
      expected: false,
    },
    {
      name: "open after due time",
      reminder: { completed: false, dueAt: 999 },
      now: 1000,
      expected: true,
    },
    {
      name: "completed after due time",
      reminder: { completed: true, dueAt: 999 },
      now: 1000,
      expected: !rule.excludeCompleted,
    },
  ];
}
export function prepareDemo(directory, rule) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "reminders.mjs"), baseline);
  writeFileSync(
    join(directory, "acceptance.mjs"),
    `import assert from 'node:assert/strict';\nimport {isDue} from './reminders.mjs';\nconst cases=${JSON.stringify(casesFor(rule))};\nlet failures=0;\nfor(const c of cases){try{assert.equal(isDue(c.reminder,c.now),c.expected);console.log('PASS '+c.name)}catch(e){failures++;console.log('FAIL '+c.name+' expected '+c.expected+' received '+isDue(c.reminder,c.now))}}\nprocess.exitCode=failures?1:0;\n`,
  );
  return snapshot(directory);
}
export function snapshot(directory) {
  return hash(
    readFileSync(join(directory, "reminders.mjs"), "utf8") +
      readFileSync(join(directory, "acceptance.mjs"), "utf8"),
  );
}
export function applyDemo(directory, rule, expected) {
  if (snapshot(directory) !== expected) throw Error("SnapshotChanged");
  writeFileSync(join(directory, "reminders.mjs"), corrected(rule));
  return snapshot(directory);
}
export async function runDemo(directory, { signal } = {}) {
  const root = realpathSync(directory);
  const nodeDir = dirname(realpathSync(process.execPath));
  const profile = `(version 1) (allow default) (deny network*) (deny file-read-data (require-not (require-any (literal "/") (subpath "/private/etc") (subpath "/dev") (subpath "/System") (subpath "/usr") (subpath "/opt/homebrew") (subpath "/private/var/db/dyld") (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(nodeDir)}) (subpath ${JSON.stringify(dirname(nodeDir))})))) (deny file-write* (require-not (subpath ${JSON.stringify(root)})))`;
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let output = "",
      exceeded = false,
      timedOut = false;
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        "/usr/bin/env",
        "-i",
        "PATH=/usr/bin:/bin",
        "HOME=" + root,
        "TMPDIR=" + root,
        process.execPath,
        "acceptance.mjs",
      ],
      { cwd: root, signal, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15000);
    const collect = (b) => {
      output += b.toString();
      if (Buffer.byteLength(output) > 65536) {
        exceeded = true;
        output = output.slice(0, 65536);
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, term) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(Error("Interrupted"));
      if (exceeded || timedOut) return reject(Error("BudgetExceeded"));
      if (!/PASS |FAIL /.test(output))
        return reject(
          Error(
            "SandboxUnavailable: exit=" +
              code +
              " signal=" +
              term +
              " " +
              output.slice(0, 400),
          ),
        );
      resolve({
        exitCode: code,
        signal: term,
        output,
        durationMs: Date.now() - start,
        sandboxed: true,
        command: ["sandbox-exec", process.execPath, "acceptance.mjs"],
        sourceHash: snapshot(root),
        outputHash: hash(output),
        observedAt: new Date().toISOString(),
      });
    });
  });
}

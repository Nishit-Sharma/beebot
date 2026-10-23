import { test } from "node:test";
export function macSandboxTest(name, fn) {
  if (process.platform !== "darwin")
    return test.skip(name, { skip: "macOS sandbox required" }, fn);
  return test(name, fn);
}

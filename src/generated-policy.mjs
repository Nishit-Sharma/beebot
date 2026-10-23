import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "./demo-runner.mjs";
const ops = {
  add: "+",
  subtract: "-",
  multiply: "*",
  divide: "/",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  equal: "===",
  and: "&&",
  or: "||",
};
export function compileExpression(root) {
  let nodes = 0;
  function visit(n, depth = 0) {
    if (
      ++nodes > 64 ||
      depth > 12 ||
      !n ||
      typeof n !== "object" ||
      Array.isArray(n)
    )
      throw Error("InvalidExpression");
    if (Object.hasOwn(n, "value")) {
      if (
        (n.value !== null &&
          !["string", "number", "boolean"].includes(typeof n.value)) ||
        (typeof n.value === "number" && !Number.isFinite(n.value)) ||
        (typeof n.value === "string" && n.value.length > 500)
      )
        throw Error("InvalidLiteral");
      return JSON.stringify(n.value);
    }
    if (Object.hasOwn(n, "field")) {
      if (
        typeof n.field !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(n.field) ||
        ["constructor", "prototype", "__proto__"].includes(n.field)
      )
        throw Error("InvalidField");
      return "input[" + JSON.stringify(n.field) + "]";
    }
    if (n.op === "if") {
      if (!Array.isArray(n.args) || n.args.length !== 3)
        throw Error("InvalidArity");
      return (
        "(" +
        visit(n.args[0], depth + 1) +
        " ? " +
        visit(n.args[1], depth + 1) +
        " : " +
        visit(n.args[2], depth + 1) +
        ")"
      );
    }
    if (n.op === "not" || n.op === "lower" || n.op === "trim") {
      if (!Array.isArray(n.args) || n.args.length !== 1)
        throw Error("InvalidArity");
      const x = visit(n.args[0], depth + 1);
      return n.op === "not"
        ? "(!" + x + ")"
        : "String(" +
            x +
            ")." +
            (n.op === "lower" ? "toLowerCase" : "trim") +
            "()";
    }
    if (
      !Object.hasOwn(ops, n.op) ||
      !Array.isArray(n.args) ||
      n.args.length !== 2
    )
      throw Error("InvalidOperator");
    return (
      "(" +
      visit(n.args[0], depth + 1) +
      " " +
      ops[n.op] +
      " " +
      visit(n.args[1], depth + 1) +
      ")"
    );
  }
  return "export function policy(input) { return " + visit(root) + "; }\n";
}
export const generatedBaseline =
  "export function policy(input) { return null; }\n";
export function validateRecipe(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 8000)
    throw Error("InvalidRecipe");
  const r = JSON.parse(content);
  if (
    !Array.isArray(r.cases) ||
    r.cases.length < 2 ||
    r.cases.length > 20 ||
    r.cases.every((c) => c.expected === null)
  )
    throw Error("InvalidCases");
  for (const c of r.cases) {
    if (
      typeof c.name !== "string" ||
      !c.name ||
      c.name.length > 100 ||
      !c.input ||
      typeof c.input !== "object" ||
      Array.isArray(c.input) ||
      JSON.stringify(c.input).length > 1000 ||
      !Object.hasOwn(c, "expected") ||
      JSON.stringify(c.expected).length > 1000
    )
      throw Error("InvalidCase");
  }
  return { ...r, source: compileExpression(r.expression) };
}
export function prepareGenerated(directory, recipe) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "reminders.mjs"), generatedBaseline);
  writeFileSync(
    join(directory, "acceptance.mjs"),
    `import assert from 'node:assert/strict';import {policy} from './reminders.mjs';\nconst cases=${JSON.stringify(recipe.cases)};let failed=0;for(const c of cases){try{assert.deepStrictEqual(policy(c.input),c.expected);console.log('PASS '+c.name)}catch{failed++;console.log('FAIL '+c.name)}}process.exitCode=failed?1:0;\n`,
  );
  return snapshot(directory);
}
export function applyGenerated(directory, recipe, expectedHash) {
  if (snapshot(directory) !== expectedHash) throw Error("SnapshotChanged");
  writeFileSync(join(directory, "reminders.mjs"), recipe.source);
}
/** Owner-supplied examples are a separate oracle, never inferred from the proposed expression. */
export function bindOwnerChecks(recipe, checks = []) {
  if (!Array.isArray(checks) || checks.length > 10)
    throw Error("InvalidOwnerChecks");
  for (const check of checks) {
    if (
      !check ||
      typeof check.name !== "string" ||
      !check.name ||
      !check.input ||
      typeof check.input !== "object" ||
      Array.isArray(check.input) ||
      !Object.hasOwn(check, "expected") ||
      JSON.stringify(check).length > 2000
    )
      throw Error("InvalidOwnerCheck");
    const proposed = recipe.cases.find(
      (c) => JSON.stringify(c.input) === JSON.stringify(check.input),
    );
    if (
      proposed &&
      JSON.stringify(proposed.expected) !== JSON.stringify(check.expected)
    )
      throw Error("OwnerAcceptanceConflictsWithProposedCase");
  }
  return validateRecipe(
    JSON.stringify({
      ...recipe,
      cases: [
        ...recipe.cases,
        ...checks.map((c) => ({ ...c, name: "Owner: " + c.name })),
      ],
    }),
  );
}

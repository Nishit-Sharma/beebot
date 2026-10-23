import { macSandboxTest } from "./mac-sandbox.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo, prepareDemo } from "../src/demo-runner.mjs";
macSandboxTest(
  "actual sandbox denies outside read/write and loopback network, with clean child environment",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bee-isolation-")),
      workspace = join(root, "work"),
      secret = join(root, "outside.txt"),
      outside = join(root, "blocked.txt");
    writeFileSync(secret, "PRIVATE_PROBE_VALUE");
    prepareDemo(workspace, { inclusive: true, excludeCompleted: true });
    writeFileSync(
      join(workspace, "acceptance.mjs"),
      `import fs from 'node:fs';import net from 'node:net';for(const [name,fn] of [['read',()=>fs.readFileSync(${JSON.stringify(secret)})],['write',()=>fs.writeFileSync(${JSON.stringify(outside)},'bad')]]){try{fn();console.log('FAIL '+name);process.exitCode=1}catch{console.log('PASS denied '+name)}}if(process.env.BEE_TEST_SECRET){console.log('FAIL env');process.exitCode=1}else console.log('PASS clean env');await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>{console.log('FAIL network');process.exitCode=1;s.destroy();resolve()});s.on('error',e=>{if(e.code==='EPERM'||e.code==='EACCES')console.log('PASS denied network');else{console.log('FAIL unproven network '+e.code);process.exitCode=1}resolve()})});`,
    );
    process.env.BEE_TEST_SECRET = "DO_NOT_INHERIT";
    try {
      const r = await runDemo(workspace);
      assert.equal(r.exitCode, 0, r.output);
      assert.match(r.output, /PASS denied network/);
      assert.equal(existsSync(outside), false);
      assert.equal(readFileSync(secret, "utf8"), "PRIVATE_PROBE_VALUE");
    } finally {
      delete process.env.BEE_TEST_SECRET;
    }
  },
);

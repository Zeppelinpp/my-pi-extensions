/**
 * tests/permission-mode.test.ts — tool_call routing per mode.
 * Run: node tests/permission-mode.test.ts   (Node >= 23, type stripping)
 */

import assert from "node:assert/strict";
import ext from "../index.ts";

type ConfirmCall = { title: string; message: string };

function setup(opts: { confirmResult?: boolean } = {}) {
  const handlers: Record<string, Function> = {};
  const commands: Record<string, { handler: Function }> = {};
  const pi = {
    on: (ev: string, fn: Function) => { handlers[ev] = fn; },
    registerCommand: (n: string, d: { handler: Function }) => { commands[n] = d; },
    registerShortcut: () => {},
    appendEntry: () => {},
  };
  ext(pi as any);

  const confirms: ConfirmCall[] = [];
  const ctx = {
    cwd: "/tmp/work",
    ui: {
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        return opts.confirmResult ?? true;
      },
      setStatus: () => {},
      theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
    },
    sessionManager: { getEntries: () => [] },
  };
  return { handlers, commands, ctx, confirms };
}

const write = (path: string) => ({ toolName: "write", input: { path } });
const edit = (path: string) => ({ toolName: "edit", input: { path } });
const bash = (command: string) => ({ toolName: "bash", input: { command } });

type TestFn = () => Promise<void>;
const tests: [string, TestFn][] = [];
const test = (name: string, fn: TestFn) => tests.push([name, fn]);

// -- bypass: everything allowed, no confirms, even outside cwd --

test("bypass: write outside cwd allowed without confirm", async () => {
  const { handlers, commands, ctx, confirms } = setup();
  await commands.mode!.handler("bypass", ctx);
  const r = await handlers.tool_call!(write("/etc/passwd"), ctx);
  assert.equal(r, undefined);
  assert.equal(confirms.length, 0, "no confirm in bypass");
});

test("bypass: edit outside cwd and dangerous bash allowed without confirm", async () => {
  const { handlers, commands, ctx, confirms } = setup();
  await commands.mode!.handler("bypass", ctx);
  assert.equal(await handlers.tool_call!(edit("/var/log/syslog"), ctx), undefined);
  assert.equal(await handlers.tool_call!(bash("rm -rf /tmp/x"), ctx), undefined);
  assert.equal(confirms.length, 0);
});

// -- accept: cwd edits free, outside cwd confirmed, rm -rf confirmed --

test("accept: write inside cwd allowed without confirm", async () => {
  const { handlers, ctx, confirms } = setup(); // default mode = accept
  const r = await handlers.tool_call!(write("src/a.ts"), ctx);
  assert.equal(r, undefined);
  assert.equal(confirms.length, 0);
});

test("accept: write outside cwd still requires confirm", async () => {
  const { handlers, ctx, confirms } = setup({ confirmResult: false });
  const r = await handlers.tool_call!(write("../outside.ts"), ctx);
  assert.equal(confirms.length, 1);
  assert.equal((r as any)?.block, true);
});

test("accept: rm -rf asks; allowed when confirmed", async () => {
  const { handlers, ctx, confirms } = setup({ confirmResult: true });
  const r = await handlers.tool_call!(bash("rm -rf /tmp/build"), ctx);
  assert.equal(r, undefined, "confirmed → allowed");
  assert.equal(confirms.length, 1);
  assert.match(confirms[0]!.message, /rm -rf/);
});

test("accept: rm -rf blocked when declined", async () => {
  const { handlers, ctx, confirms } = setup({ confirmResult: false });
  const r = await handlers.tool_call!(bash("rm -rf /tmp/build"), ctx);
  assert.equal((r as any)?.block, true);
  assert.match((r as any).reason, /rm -rf/);
  assert.equal(confirms.length, 1);
});

test("accept: rm -rf detection variants", async () => {
  const variants = [
    "rm -rf /tmp/x",
    "rm -fr /tmp/x",
    "rm -r -f /tmp/x",
    "sudo rm -rf /tmp/x",
    "rm --recursive --force /tmp/x",
    "cd /tmp && rm -rf node_modules",
  ];
  for (const cmd of variants) {
    const { handlers, ctx, confirms } = setup();
    await handlers.tool_call!(bash(cmd), ctx);
    assert.equal(confirms.length, 1, `should ask: ${cmd}`);
  }
});

test("accept: non-destructive bash runs without confirm", async () => {
  const harmless = [
    "ls -la",
    "git status",
    "rm -r /tmp/x",        // no force flag
    "rm -f /tmp/x",        // not recursive
    "rm file.txt",
    "grep -rn foo src",    // contains r but not rm
  ];
  for (const cmd of harmless) {
    const { handlers, ctx, confirms } = setup();
    const r = await handlers.tool_call!(bash(cmd), ctx);
    assert.equal(r, undefined, `should pass: ${cmd}`);
    assert.equal(confirms.length, 0, `no confirm: ${cmd}`);
  }
});

// -- ask mode unchanged --

test("ask: readonly bash passes, everything else asks", async () => {
  const { handlers, commands, ctx, confirms } = setup({ confirmResult: false });
  await commands.mode!.handler("ask", ctx);

  assert.equal(await handlers.tool_call!(bash("ls -la"), ctx), undefined);
  assert.equal(confirms.length, 0, "readonly passes");

  assert.equal((await handlers.tool_call!(bash("git status"), ctx) as any)?.block, true);
  assert.equal((await handlers.tool_call!(write("a.ts"), ctx) as any)?.block, true);
  assert.equal(confirms.length, 2, "non-readonly bash and write both ask");
});

// -- runner --

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok ${++passed} - ${name}`);
  } catch (err) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
process.exit(failed ? 1 : 0);

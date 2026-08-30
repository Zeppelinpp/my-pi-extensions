/**
 * tests/permission-mode.test.ts — tool_call routing per mode.
 * Run: node tests/permission-mode.test.ts   (Node >= 23, type stripping)
 */

import assert from "node:assert/strict";
import ext from "../index.ts";

type ConfirmCall = { title: string; message: string };

function setup(opts: { confirmResult?: boolean; mode?: string; cwd?: string } = {}) {
  const handlers: Record<string, Function> = {};
  const commands: Record<string, { handler: Function }> = {};
  const pi = {
    on: (ev: string, fn: Function) => { handlers[ev] = fn; },
    registerCommand: (n: string, d: { handler: Function }) => { commands[n] = d; },
    registerShortcut: () => {},
    appendEntry: () => {},
  };

  const confirms: ConfirmCall[] = [];
  const ctx = {
    cwd: opts.cwd ?? "/tmp/work",
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

  ext(pi as any);
  if (opts.mode) {
    commands.mode!.handler(opts.mode, ctx as any);
  }
  return { handlers, commands, ctx, confirms };
}

const write = (path: string) => ({ toolName: "write", input: { path } });
const edit = (path: string) => ({ toolName: "edit", input: { path } });
const bash = (command: string) => ({ toolName: "bash", input: { command } });
const powershell = (command: string, toolName = "powershell") => ({
  toolName,
  input: { command },
});

type TestFn = () => Promise<void>;
const tests: [string, TestFn][] = [];
const test = (name: string, fn: TestFn) => tests.push([name, fn]);

// -- bypass: everything allowed, no confirms, even outside cwd --

test("default mode is bypass: write outside cwd allowed without confirm", async () => {
  const { handlers, ctx, confirms } = setup(); // no mode set
  const r = await handlers.tool_call!(write("/etc/passwd"), ctx);
  assert.equal(r, undefined);
  assert.equal(confirms.length, 0, "no confirm in default bypass");
});

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

// -- accept: cwd edits free, writes anywhere, edit outside cwd confirmed, rm -rf confirmed --

test("accept: write inside cwd allowed without confirm", async () => {
  const { handlers, ctx, confirms } = setup({ mode: "accept" });
  const r = await handlers.tool_call!(write("src/a.ts"), ctx);
  assert.equal(r, undefined);
  assert.equal(confirms.length, 0);
});

test("accept: write outside cwd allowed without confirm", async () => {
  const { handlers, ctx, confirms } = setup({ mode: "accept" });
  const r = await handlers.tool_call!(write("../outside.ts"), ctx);
  assert.equal(r, undefined);
  assert.equal(confirms.length, 0);
});

test("accept: edit outside cwd still requires confirm", async () => {
  const { handlers, ctx, confirms } = setup({ confirmResult: false, mode: "accept" });
  const r = await handlers.tool_call!(edit("../outside.ts"), ctx);
  assert.equal(confirms.length, 1);
  assert.equal((r as any)?.block, true);
});

test("accept: an in-cwd path beginning with two dots is not treated as parent traversal", async () => {
  const { handlers, ctx, confirms } = setup({ mode: "accept" });
  const r = await handlers.tool_call!(edit("..cache/file.ts"), ctx);
  assert.equal(r, undefined);
  assert.equal(confirms.length, 0);
});

if (process.platform === "win32") {
  test("accept: cross-drive edit is outside cwd", async () => {
    const { handlers, ctx, confirms } = setup({
      confirmResult: false,
      mode: "accept",
      cwd: "C:\\work",
    });
    const r = await handlers.tool_call!(edit("D:\\outside.ts"), ctx);
    assert.equal((r as any)?.block, true);
    assert.equal(confirms.length, 1);
  });
}

test("accept: rm -rf asks; allowed when confirmed", async () => {
  const { handlers, ctx, confirms } = setup({ mode: "accept" });
  const r = await handlers.tool_call!(bash("rm -rf /tmp/build"), ctx);
  assert.equal(r, undefined, "confirmed → allowed");
  assert.equal(confirms.length, 1);
  assert.match(confirms[0]!.message, /rm -rf/);
});

test("accept: rm -rf blocked when declined", async () => {
  const { handlers, ctx, confirms } = setup({ confirmResult: false, mode: "accept" });
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
    const { handlers, ctx, confirms } = setup({ mode: "accept" });
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
    const { handlers, ctx, confirms } = setup({ mode: "accept" });
    const r = await handlers.tool_call!(bash(cmd), ctx);
    assert.equal(r, undefined, `should pass: ${cmd}`);
    assert.equal(confirms.length, 0, `no confirm: ${cmd}`);
  }
});

test("accept: destructive PowerShell asks in either tool-name casing", async () => {
  for (const toolName of ["powershell", "PowerShell"]) {
    const { handlers, ctx, confirms } = setup({ confirmResult: false, mode: "accept" });
    const r = await handlers.tool_call!(
      powershell("Remove-Item C:\\build -Recurse -Force", toolName),
      ctx,
    );
    assert.equal((r as any)?.block, true);
    assert.equal(confirms.length, 1);
  }
});

test("accept: non-destructive PowerShell runs without confirm", async () => {
  const { handlers, ctx, confirms } = setup({ mode: "accept" });
  assert.equal(await handlers.tool_call!(powershell("Get-ChildItem"), ctx), undefined);
  assert.equal(confirms.length, 0);
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

test("ask: chained commands and PowerShell require confirmation", async () => {
  const { handlers, ctx, confirms } = setup({ confirmResult: false, mode: "ask" });
  assert.equal((await handlers.tool_call!(bash("ls && touch x"), ctx) as any)?.block, true);
  assert.equal(
    (await handlers.tool_call!(powershell("Get-ChildItem"), ctx) as any)?.block,
    true,
  );
  assert.equal(confirms.length, 2);
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

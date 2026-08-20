/**
 * tests/popup.test.ts — smoke tests for the /context popup component.
 * Run: node tests/popup.test.ts   (Node >= 23; index.ts is loaded via jiti
 * because it uses non-erasable TS syntax, same as Pi's extension loader)
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Resolve pi packages from the global pi install (same as Pi's loader aliases).
const PI_MODULES =
  "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules";
const require = createRequire(import.meta.url);
const { createJiti } = require(`${PI_MODULES}/jiti`);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui": `${PI_MODULES}/@earendil-works/pi-tui`,
  },
});
const { visibleWidth } = require(`${PI_MODULES}/@earendil-works/pi-tui`);
const ext = await jiti.import("../index.ts", { default: true });

// -- stubs --

const theme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
};

function makeTui(rows: number) {
  return {
    terminal: { rows, cols: 120 },
    renders: 0,
    requestRender() { this.renders++; },
  };
}

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

type TestFn = () => Promise<void>;
const tests: [string, TestFn][] = [];
const test = (name: string, fn: TestFn) => tests.push([name, fn]);

/** Drive the extension through its public surface and capture the popup component. */
async function openPopup(opts: { rows?: number; skills?: number; totalTokens?: number | null }) {
  const handlers: Record<string, Function> = {};
  const commands: Record<string, { handler: Function }> = {};
  const pi = {
    on: (ev: string, fn: Function) => { handlers[ev] = fn; },
    registerCommand: (name: string, def: { handler: Function }) => { commands[name] = def; },
  };
  ext(pi as any);

  const skills = Array.from({ length: opts.skills ?? 30 }, (_, i) => ({
    name: `skill-number-${i}`,
    filePath: "/nonexistent", // getSkillTokens → 0
    disableModelInvocation: i % 7 === 0,
  }));
  handlers.before_agent_start!({
    systemPromptOptions: { skills },
    systemPrompt: "x".repeat(4000),
  });

  let component: any;
  const ctx = {
    cwd: "/tmp",
    sessionManager: { buildSessionContext: () => ({ messages: [] }) },
    getContextUsage: () =>
      opts.totalTokens === null
        ? { tokens: null, contextWindow: 0 }
        : { tokens: opts.totalTokens ?? 120000, contextWindow: 200000 },
    ui: {
      notify: () => {},
      custom: async (factory: Function) => {
        const tui = makeTui(opts.rows ?? 40);
        component = factory(tui, theme, null, () => {});
      },
    },
  };
  await commands.context!.handler("", ctx);
  return { component, tui: null as any, getTui: () => component.tui };
}

// -- tests --

test("height adapts to terminal rows; popup never exceeds terminal height", async () => {
  for (const rows of [15, 24, 40, 60]) {
    const { component } = await openPopup({ rows, skills: 40 });
    const out = component.render(100);
    assert.ok(
      out.length <= rows - 1,
      `rows=${rows}: popup height ${out.length} should fit terminal`,
    );
  }
});

test("all rows fit the inner width (ANSI-aware)", async () => {
  const { component } = await openPopup({ rows: 24, skills: 40 });
  const width = 80;
  for (const line of component.render(width)) {
    assert.equal(visibleWidth(line), width, `row width mismatch: ${strip(line)}`);
  }
});

test("skills are flow-wrapped, not one per line", async () => {
  const { component } = await openPopup({ rows: 60, skills: 40 });
  // 40 skills one-per-line would be 40+ rows; wrapped must be far fewer.
  assert.ok(component.lines.length < 20, `lines=${component.lines.length}`);
});

test("scrolling is clamped and moves the visible window", async () => {
  const { component } = await openPopup({ rows: 16, skills: 60 });
  const top = component.render(100).join("\n");

  for (let i = 0; i < 5; i++) component.handleInput("j");
  const scrolled = component.render(100).join("\n");
  assert.notEqual(scrolled, top, "content should change after scrolling");

  for (let i = 0; i < 100; i++) component.handleInput("j");
  const h = component.contentHeight;
  assert.equal(component.scrollOffset, Math.max(0, component.lines.length - h), "clamped at bottom");

  for (let i = 0; i < 100; i++) component.handleInput("k");
  assert.equal(component.scrollOffset, 0, "clamped at top");
});

test("PgDn/PgUp page, g/G jump; every nav key requests a render", async () => {
  const { component } = await openPopup({ rows: 16, skills: 60 });
  const tui = component.tui;
  component.render(100); // TUI renders before forwarding input

  component.handleInput("\x1b[6~"); // PgDn
  assert.ok(component.scrollOffset > 1, "PgDn pages down");
  const afterPg = component.scrollOffset;
  component.handleInput("\x1b[5~"); // PgUp
  assert.ok(component.scrollOffset < afterPg, "PgUp pages up");

  component.handleInput("G");
  assert.equal(component.scrollOffset, Math.max(0, component.lines.length - component.contentHeight));
  component.handleInput("g");
  assert.equal(component.scrollOffset, 0);

  assert.ok(tui.renders >= 4, `requestRender called per nav input (got ${tui.renders})`);
});

test("scrollbar track appears only when content overflows", async () => {
  const tall = await openPopup({ rows: 16, skills: 60 });
  const scrollable = tall.component.render(100).map(strip);
  assert.ok(scrollable.some((l) => /█│$/.test(l)), "thumb visible when overflowing");
  assert.ok(scrollable.some((l) => /││$/.test(l)), "track visible when overflowing");

  const short = await openPopup({ rows: 60, skills: 3 });
  const fits = short.component.render(100).map(strip);
  // A scrollbar row ends with "<track-or-thumb>│"; content rows never do.
  assert.ok(
    !fits.some((l) => /[█│]│$/.test(l)),
    "no scrollbar column when everything fits",
  );
});

test("terminal shrink while scrolled clamps the offset", async () => {
  const { component } = await openPopup({ rows: 40, skills: 120 });
  component.render(100);
  component.handleInput("G");
  const before = component.scrollOffset;
  assert.ok(before > 0);
  component.tui.terminal.rows = 12; // shrink
  component.render(100);
  assert.ok(component.scrollOffset >= before, "smaller viewport → larger offset, still clamped");
  assert.equal(
    component.scrollOffset,
    Math.max(0, component.lines.length - component.contentHeight),
  );
});

test("no-usage path renders without total/bar", async () => {
  const { component } = await openPopup({ rows: 40, skills: 5, totalTokens: null });
  const text = strip(component.render(100).join("\n"));
  assert.ok(text.includes("Context Usage"));
  assert.ok(text.includes("messages"));
});

test("footer shows scroll position only when scrollable", async () => {
  const tall = await openPopup({ rows: 16, skills: 60 });
  const footerLine = strip(tall.component.render(100).at(-2)!);
  assert.ok(/\d+\/\d+/.test(footerLine), `position in footer: ${footerLine}`);

  const short = await openPopup({ rows: 60, skills: 3 });
  const shortFooter = strip(short.component.render(100).at(-2)!);
  assert.ok(!/\d+\/\d+/.test(shortFooter), "no position when not scrollable");
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

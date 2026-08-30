/** Cross-platform regression test for Git filenames passed by /diff. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

function resolvePiPackage(): string {
  if (process.env.PI_CODING_AGENT_PACKAGE) return process.env.PI_CODING_AGENT_PACKAGE;
  const windowsPrefix =
    process.env.npm_config_prefix ||
    (process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined);
  const globalRoot =
    process.platform === "win32" && windowsPrefix
      ? join(windowsPrefix, "node_modules")
      : execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  return join(globalRoot, "@earendil-works", "pi-coding-agent");
}

const piPackage = resolvePiPackage();
const piModules = join(piPackage, "node_modules");
const require = createRequire(import.meta.url);
const { createJiti } = require(join(piModules, "jiti"));
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": piPackage,
    "@earendil-works/pi-tui": join(piModules, "@earendil-works", "pi-tui"),
  },
});
const module = await jiti.import("../index.ts");
const runGit = (module as any).runGit as (
  cwd: string,
  args: string[],
  timeout: number,
) => string;

assert.equal(typeof runGit, "function");

const repo = await mkdtemp(join(tmpdir(), "diff-view-test-"));
const files = ["space name.txt", "amp&name.txt", "unicode-测试.txt"];

try {
  runGit(repo, ["init", "--quiet"], 5000);
  runGit(repo, ["config", "user.name", "Pi Test"], 5000);
  runGit(repo, ["config", "user.email", "pi-test@example.invalid"], 5000);
  runGit(repo, ["config", "core.autocrlf", "false"], 5000);

  for (const file of files) await writeFile(join(repo, file), "before\n", "utf8");
  runGit(repo, ["add", "--", ...files], 5000);
  runGit(repo, ["commit", "--quiet", "-m", "initial"], 5000);

  for (const file of files) await writeFile(join(repo, file), "after\n", "utf8");

  const listed = runGit(repo, ["diff", "--name-only", "-z"], 5000)
    .split("\0")
    .filter(Boolean);
  assert.deepEqual(new Set(listed), new Set(files));

  for (const file of files) {
    const diff = runGit(repo, ["diff", "--", file], 5000);
    assert.match(diff, /-before/);
    assert.match(diff, /\+after/);
  }

  console.log(`ok - Git filenames round-trip safely (${process.platform})`);
} finally {
  await rm(repo, { recursive: true, force: true });
}

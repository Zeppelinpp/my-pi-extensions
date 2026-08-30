import assert from "node:assert/strict";
import { normalizeSocketEndpoint } from "../herdr-agent-state.ts";

const slash = String.fromCharCode(92);
const pipePrefix = slash + slash + "." + slash + "pipe" + slash;
const cases: Array<[string, string]> = [
  ["herdr", pipePrefix + "herdr"],
  [pipePrefix + "herdr", pipePrefix + "herdr"],
  ["//./pipe/herdr", pipePrefix + "herdr"],
  [slash + "herdr", pipePrefix + "herdr"],
];

for (const [input, windowsExpected] of cases) {
  assert.equal(
    normalizeSocketEndpoint(input),
    process.platform === "win32" ? windowsExpected : input,
  );
}

console.log(`ok - Herdr socket endpoint normalization (${process.platform})`);

import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parseWaitMs } from "../src/cli.js";

test("task wait parsing preserves an explicit zero", () => {
  assert.equal(parseWaitMs(0), 0);
  assert.equal(parseWaitMs("0"), 0);
  assert.equal(parseWaitMs(undefined), 30000);
  assert.equal(parseWaitMs("not-a-number"), 30000);
  assert.equal(parseWaitMs(400000), 300000);
});

test("argument parsing does not consume the next flag", () => {
  assert.deepEqual(parseArgs(["--verbose", "--port", "8787", "--host=localhost"]), {
    verbose: true,
    port: "8787",
    host: "localhost"
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseWaitMs } from "../src/cli.js";

test("task wait parsing preserves an explicit zero", () => {
  assert.equal(parseWaitMs(0), 0);
  assert.equal(parseWaitMs("0"), 0);
  assert.equal(parseWaitMs(undefined), 30000);
  assert.equal(parseWaitMs("not-a-number"), 30000);
  assert.equal(parseWaitMs(400000), 300000);
});

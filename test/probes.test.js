import test from "node:test";
import assert from "node:assert/strict";
import { runProbe } from "../src/probes.js";

test("runs a DNS probe and returns structured results", async () => {
  const result = await runProbe({
    source_host: "test",
    checks: [{ type: "dns", name: "localhost" }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks[0].type, "dns");
  assert.ok(result.checks[0].addresses.length > 0);
});

test("reports unsupported probes without aborting the result", async () => {
  const result = await runProbe({ checks: [{ type: "shell" }] });
  assert.equal(result.ok, false);
  assert.match(result.checks[0].error, /unsupported probe type/);
});

test("reports malformed checks without aborting the probe", async () => {
  const result = await runProbe({ checks: [null, { type: "dns", name: "localhost" }] });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].type, "invalid");
  assert.match(result.checks[0].error, /check must be an object/);
  assert.equal(result.checks[1].ok, true);
});

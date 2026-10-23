import test from "node:test";
import assert from "node:assert/strict";
import { runProbe } from "../src/probes.js";

test("a cancelled probe does not start any checks", async () => {
  await assert.rejects(runProbe({ checks: [{ type: "dns", name: "localhost" }] }, {
    signal: AbortSignal.abort(new Error("cancel probe"))
  }), /cancel probe/);
});

test("cancelling an HTTP probe aborts its fetch and skips remaining checks", async (t) => {
  let requests = 0;
  let fetchSignal;
  t.mock.method(globalThis, "fetch", (url, { signal }) => {
    requests += 1;
    fetchSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = runProbe({ checks: [{ type: "http", url: "http://relay" }, { type: "dns", name: "localhost" }] }, { signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(requests, 1);
  assert.equal(fetchSignal.aborted, true);
});

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

test("bounds a report for 15,000 malformed checks without rejecting the dispatch", async () => {
  const checks = Array.from({ length: 15_000 }, () => ({}));
  assert.ok(Buffer.byteLength(JSON.stringify({ checks })) < 64 * 1024);
  const result = await runProbe({ checks });
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.equal(result.total_checks, checks.length);
  assert.equal(result.completed_checks, checks.length);
  assert.equal(result.omitted_checks, checks.length - result.checks.length);
  assert.ok(result.omitted_checks > 0);
  assert.ok(result.checks.length > 0);
  assert.ok(result.checks.every((check) => check.ok === false));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
});

test("a failure after the detail budget is exhausted still makes the probe fail", async (t) => {
  let requests = 0;
  let cancellations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    if (requests === 701) throw new Error("last check failed");
    return {
      status: 200,
      headers: [["x-detail", "a".repeat(1024)]],
      body: { cancel() { cancellations += 1; } }
    };
  });
  const checks = Array.from({ length: 701 }, () => ({ type: "http", url: "http://relay" }));
  const result = await runProbe({ checks });
  assert.equal(requests, checks.length);
  assert.equal(cancellations, checks.length - 1);
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.equal(result.total_checks, checks.length);
  assert.equal(result.completed_checks, checks.length);
  assert.equal(result.omitted_checks, checks.length - result.checks.length);
  assert.ok(result.omitted_checks > 1);
  assert.ok(result.checks.length > 0);
  assert.ok(result.checks.every((check) => check.ok === true));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
});

test("preserves the complete shape of small HTTP reports, including Unicode and escaped headers", async (t) => {
  const headers = { "x-雪": "🦊\u0000\n\"\\\ud800" };
  t.mock.method(globalThis, "fetch", async () => ({ status: 204, headers: Object.entries(headers) }));
  const result = await runProbe({ source_host: "source", target_host: "target", checks: [{ type: "http", url: "http://relay" }] });
  assert.deepEqual(result, {
    source_host: "source",
    target_host: "target",
    ok: true,
    checks: [{ type: "http", url: "http://relay", status: 204, headers, ok: true, duration_ms: result.checks[0].duration_ms }]
  });
  assert.equal(typeof result.checks[0].duration_ms, "number");
});

test("bounds single-check URLs, errors, header names and header values in encoded bytes", async (t) => {
  const cases = [
    { name: "URL", url: `http://relay/${"雪".repeat(180_000)}`, headers: [], ok: true },
    { name: "error", url: "http://relay", error: "\u0000".repeat(90_000), ok: false },
    { name: "header name", url: "http://relay", headers: [["🦊".repeat(140_000), "value"]], ok: true },
    { name: "header value", url: "http://relay", headers: [["x-detail", "\ud800".repeat(90_000)]], ok: true }
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      let requests = 0;
      let cancellations = 0;
      t.mock.method(globalThis, "fetch", async () => {
        requests += 1;
        if (scenario.error) throw new Error(scenario.error);
        return { status: 200, headers: scenario.headers, body: { cancel() { cancellations += 1; } } };
      });
      const result = await runProbe({ checks: [{ type: "http", url: scenario.url }] });
      assert.equal(requests, 1);
      assert.equal(cancellations, scenario.ok ? 1 : 0);
      assert.equal(result.ok, scenario.ok);
      assert.equal(result.truncated, true);
      assert.equal(result.total_checks, 1);
      assert.equal(result.completed_checks, 1);
      assert.equal(result.omitted_checks, 1);
      assert.deepEqual(result.checks, []);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
    });
  }
});

test("stops collecting HTTP headers once a single check exceeds the budget", async (t) => {
  let requests = 0;
  let readHeaders = 0;
  let cancellations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return {
      status: 200,
      headers: {
        *[Symbol.iterator]() {
          readHeaders += 1;
          yield ["large", "a".repeat(512 * 1024)];
          readHeaders += 1;
          throw new Error("header collection exceeded the budget");
        }
      },
      body: { cancel() { cancellations += 1; } }
    };
  });
  const result = await runProbe({ checks: [{ type: "http", url: "http://relay" }, { type: "http", url: "http://relay" }] });
  assert.equal(result.ok, true);
  assert.equal(result.completed_checks, 2);
  assert.equal(result.omitted_checks, 2);
  assert.equal(requests, 2);
  assert.equal(readHeaders, 1);
  assert.equal(cancellations, 2);
});

test("bounds host metadata and identifies fields omitted from the report", async () => {
  const result = await runProbe({ source_host: "雪".repeat(180_000), target_host: "target", checks: [{}] });
  assert.equal(result.source_host, null);
  assert.equal(result.target_host, "target");
  assert.equal(result.truncated, true);
  assert.equal(result.total_checks, 1);
  assert.equal(result.completed_checks, 1);
  assert.equal(result.omitted_checks, 0);
  assert.deepEqual(result.omitted_fields, ["source_host"]);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
});

test("includes retained host metadata in the shared JSON byte budget", async () => {
  const host = "雪".repeat(80_000);
  const checks = Array.from({ length: 1000 }, () => ({}));
  const result = await runProbe({ source_host: host, target_host: host, checks });
  assert.equal(result.source_host, host);
  assert.equal(result.target_host, host);
  assert.equal(result.total_checks, checks.length);
  assert.equal(result.completed_checks, checks.length);
  assert.equal(result.omitted_checks, checks.length - result.checks.length);
  assert.ok(result.omitted_checks > 0);
  assert.ok(result.checks.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
});

test("omits deeply nested malformed detail that could overflow JSON serialization", async () => {
  let type = {};
  for (let depth = 0; depth < 10_000; depth += 1) type = { nested: type };
  const result = await runProbe({ checks: [{ type }, {}] });
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.equal(result.total_checks, 2);
  assert.equal(result.completed_checks, 2);
  assert.equal(result.omitted_checks, 2);
  assert.deepEqual(result.checks, []);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
});

test("long batches of malformed checks allow cancellation to run", async () => {
  const controller = new AbortController();
  const timer = setImmediate(() => controller.abort(new Error("cancel batch")));
  try {
    await assert.rejects(runProbe({ checks: Array.from({ length: 15_000 }, () => ({})) }, { signal: controller.signal }), /cancel batch/);
  } finally {
    clearImmediate(timer);
  }
});

test("cancellation still aborts HTTP checks after detail collection stops", async (t) => {
  const controller = new AbortController();
  let requests = 0;
  let fetchSignal;
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    requests += 1;
    if (requests === 1) return { status: 200, headers: [["large", "a".repeat(512 * 1024)]] };
    fetchSignal = signal;
    setImmediate(() => controller.abort(new Error("cancel omitted check")));
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const checks = Array.from({ length: 3 }, () => ({ type: "http", url: "http://relay" }));
  await assert.rejects(runProbe({ checks }, { signal: controller.signal }), /cancel omitted check/);
  assert.equal(requests, 2);
  assert.equal(fetchSignal.aborted, true);
});

test("cancellation interrupts stalled HTTP body cleanup", async (t) => {
  const controller = new AbortController();
  let fetchSignal;
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    fetchSignal = signal;
    return {
      status: 200,
      headers: [],
      body: {
        cancel() {
          setImmediate(() => controller.abort(new Error("cancel cleanup")));
          return new Promise(() => {});
        }
      }
    };
  });
  await assert.rejects(runProbe({ checks: [{ type: "http", url: "http://relay" }] }, { signal: controller.signal }), /cancel cleanup/);
  assert.equal(fetchSignal.aborted, true);
});

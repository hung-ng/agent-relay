import test from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "../src/http.js";

test("requestJson supplies JSON headers and aborts a stalled request", async () => {
  let seen;
  const pendingFetch = (url, options) => {
    seen = { url, options };
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };

  await assert.rejects(
    requestJson("http://relay/v1/jobs", { method: "POST", body: { kind: "test" }, timeoutMs: 10, fetchImpl: pendingFetch }),
    (error) => error.code === "ETIMEDOUT" && /timed out/.test(error.message)
  );
  assert.equal(seen.options.headers["content-type"], "application/json");
  assert.equal(seen.options.body, JSON.stringify({ kind: "test" }));
});

test("requestJson preserves caller cancellation alongside its timeout", async () => {
  const controller = new AbortController();
  const pendingFetch = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("caller aborted")), { once: true });
  });
  const pending = requestJson("http://relay/healthz", {
    signal: controller.signal,
    timeoutMs: 1000,
    fetchImpl: pendingFetch
  });
  controller.abort();
  await assert.rejects(pending, /caller aborted/);
});

test("requestJson times out while reading a response body", async () => {
  await assert.rejects(requestJson("http://relay", {
    timeoutMs: 10,
    fetchImpl: async (url, { signal }) => ({
      ok: true, status: 200,
      json: () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    })
  }), (error) => error.code === "ETIMEDOUT");
});

test("requestJson rejects malformed success responses and preserves HTTP errors", async () => {
  const json = async () => { throw new SyntaxError("not JSON"); };
  await assert.rejects(requestJson("http://relay", {
    fetchImpl: async () => ({ ok: true, status: 200, json })
  }), (error) => error.code === "EINVALIDJSON");
  await assert.rejects(requestJson("http://relay", {
    fetchImpl: async () => ({ ok: false, status: 502, json })
  }), (error) => error.status === 502);
});

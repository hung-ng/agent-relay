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

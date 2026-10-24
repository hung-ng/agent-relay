import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Worker, agentTaskArgs, runProcess } from "../src/worker.js";

test("read-only Codex tasks use the installed noninteractive policy", () => {
  assert.deepEqual(agentTaskArgs("codex", { execution_mode: "read_only", prompt: "inspect" }), [
    "exec",
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "-"
  ]);
  assert.throws(() => agentTaskArgs("codex", { execution_mode: "write", prompt: "implement" }), /agent.task.write/);
  assert.deepEqual(agentTaskArgs("codex", { execution_mode: "write", allow_write: true, prompt: "implement" }), [
    "exec",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    "-"
  ]);
  assert.deepEqual(agentTaskArgs("codex", { prompt: "plain prompt" }), agentTaskArgs("codex", { execution_mode: "read_only" }));
  assert.deepEqual(agentTaskArgs("claude", { prompt: "--dangerously-skip-permissions" }), ["-p", "--output-format", "json", "--permission-mode", "dontAsk"]);
});

test("agent prompts use stdin so large or flag-like text cannot change CLI options", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-agent-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = path.join(root, "fake agent.mjs");
  await writeFile(command, `#!/usr/bin/env node
import { createHash } from "node:crypto";
process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ args: process.argv.slice(2), bytes: Buffer.byteLength(input), hash: createHash("sha256").update(input).digest("hex") }));`, { mode: 0o700 });
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex", command, cwd: root });
  const prompt = "--dangerously-bypass-approvals-and-sandbox\n" + "inspect €\n".repeat(30_000);
  const result = await worker.runAgentTask({ prompt });
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.bytes, Buffer.byteLength(prompt));
  assert.equal(observed.hash, createHash("sha256").update(prompt).digest("hex"));
  assert.deepEqual(observed.args, ["exec", "--sandbox", "read-only", "--config", 'approval_policy="never"', "-"]);
  assert.ok(!result.args.includes(prompt));
});

test("worker subprocesses are terminated when they exceed their timeout", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 20 }),
    /timed out after 20ms/
  );
});

test("worker subprocesses stop when the worker is aborted", async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, /was aborted/);
});

test("agent workers turn requests into replies", async () => {
  const calls = [];
  const worker = new Worker({
    serverUrl: "http://bus",
    agentId: "claude@book",
    hostId: "book",
    kind: "claude",
    logger: { log() {}, error() {} }
  });
  worker.request = async (path, options = {}) => {
    calls.push({ path, options });
    return {};
  };
  worker.runAgentTask = async ({ prompt }) => ({ command: "claude", stdout: `answer: ${prompt}`, stderr: "", code: 0 });

  await worker.handleMessage({
    id: "message-1",
    sender: "codex@mini",
    recipient: "claude@book",
    type: "request",
    conversation_id: "conversation-1",
    payload: { body: "check the service" }
  });

  assert.deepEqual(calls.map((call) => call.path), [
    "/v1/messages/message-1/deliver",
    "/v1/messages",
    "/v1/messages/message-1/ack"
  ]);
  assert.equal(calls[1].options.body.recipient, "codex@mini");
  assert.equal(calls[1].options.body.type, "reply");
  assert.equal(calls[1].options.body.id, "reply:message-1");
  assert.equal(calls[1].options.body.payload.body, "answer: check the service");
});

test("agent workers skip a duplicate message after it is acknowledged", async () => {
  const calls = [];
  const worker = new Worker({
    serverUrl: "http://bus",
    agentId: "claude@book",
    hostId: "book",
    kind: "claude",
    logger: { log() {}, error() {} }
  });
  worker.request = async (path) => {
    calls.push(path);
    return { message: { status: "acknowledged" } };
  };
  worker.runAgentTask = async () => {
    throw new Error("duplicate task execution");
  };

  await worker.handleMessage({
    id: "message-2",
    sender: "codex@mini",
    recipient: "claude@book",
    type: "request",
    payload: { body: "run once" }
  });

  assert.deepEqual(calls, ["/v1/messages/message-2/deliver"]);
});

test("a failed acknowledgement resends the original reply without rerunning the task", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex", logger: { log() {} } });
  let executions = 0;
  let acknowledgements = 0;
  const replies = [];
  worker.request = async (route, options) => {
    if (route.endsWith("/ack") && acknowledgements++ === 0) throw new Error("acknowledgement lost");
    if (route === "/v1/messages") replies.push(options.body);
    return {};
  };
  worker.runAgentTask = async () => ({ stdout: String(++executions) });
  const message = { id: "message", sender: "operator", type: "request", payload: { body: "work" } };
  await assert.rejects(worker.handleMessage(message), /acknowledgement lost/);
  await worker.handleMessage(message);
  assert.equal(executions, 1);
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(worker.messageReplies.size, 0);
});

test("the event reader handles cancellation while a job is still running", async (t) => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex" });
  t.after(() => worker.stop());
  const claim = { id: "slow", target_agent: "worker", kind: "agent.task", payload: { prompt: "wait" }, claim_token: "attempt-1" };
  const requests = [];
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  worker.request = async (path) => {
    requests.push(path);
    return { job: claim };
  };
  worker.runAgentTask = async (payload, { signal } = {}) => {
    started();
    try { await delay(10_000, null, { signal }); }
    finally { aborted = signal?.aborted ?? false; }
  };
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: job.created\ndata: ${JSON.stringify(claim)}\n\n`));
      await running;
      controller.enqueue(new TextEncoder().encode(`event: job.cancelled\ndata: ${JSON.stringify({ ...claim, status: "cancelled" })}\n\n`));
      controller.close();
    }
  });
  await worker.consumeEvents(stream);
  await worker.drainPromise;
  assert.equal(aborted, true);
  assert.deepEqual(requests, ["/v1/jobs/slow/claim"]);
});

test("the event reader accepts split UTF-8, CRLF, and multiline data", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host" });
  const received = [];
  worker.handleMessage = async (message) => received.push(message);
  const bytes = new TextEncoder().encode('event: message.created\r\ndata: {"id":"message","recipient":"worker",\r\ndata: "payload":{"body":"€"}}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  await worker.consumeEvents(stream);
  await worker.drainPromise;
  assert.deepEqual(received, [{ id: "message", recipient: "worker", payload: { body: "€" } }]);
});

test("the event reader rejects an unbounded partial event", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host" });
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(2_097_153))); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(worker.consumeEvents(stream), /buffer limit/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("workers execute the claimed payload and attach its token to results", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex" });
  const calls = [];
  worker.request = async (path, options) => {
    calls.push({ path, options });
    return { job: { id: "job", kind: "agent.task", payload: { prompt: "stored" }, claim_token: "claim" } };
  };
  worker.runAgentTask = async (payload) => ({ stdout: payload.prompt });
  await worker.handleJob({ id: "job", kind: "agent.task", payload: { prompt: "event" } });
  assert.deepEqual(calls[1].options.body, { result: { stdout: "stored" }, claim_token: "claim" });
});

test("a result delivery error is not reported as an execution failure", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex" });
  const calls = [];
  worker.request = async (path) => {
    calls.push(path);
    if (path.endsWith("/claim")) return { job: { id: "job", kind: "agent.task", payload: { prompt: "stored" } } };
    throw new Error("connection lost while posting result");
  };
  worker.runAgentTask = async () => ({ stdout: "success" });
  await assert.rejects(worker.handleJob({ id: "job", kind: "agent.task", payload: { prompt: "event" } }), /connection lost/);
  assert.deepEqual(calls, ["/v1/jobs/job/claim", "/v1/jobs/job/complete"]);
});

test("a lost result is resent without executing the same attempt again", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex" });
  let executions = 0;
  let deliveries = 0;
  worker.request = async (route) => {
    if (route.endsWith("/claim")) return { job: { id: "job", kind: "agent.task", attempts: 1, claim_token: "claim", payload: { prompt: "do work" } } };
    if (deliveries++ === 0) throw new Error("connection lost");
    return {};
  };
  worker.runAgentTask = async () => ({ stdout: String(++executions) });
  await assert.rejects(worker.handleJob({ id: "job" }), /connection lost/);
  await worker.handleJob({ id: "job" });
  assert.equal(executions, 1);
  assert.equal(deliveries, 2);
  assert.equal(worker.jobOutcomes.size, 0);
});

test("a delayed heartbeat cannot discard a newer cached outcome", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex" });
  worker.jobOutcomes.set("job", { claimToken: "old", attempts: 1 });
  let startedRead;
  const reading = new Promise((resolve) => { startedRead = resolve; });
  let releaseRead;
  const slowRead = new Promise((resolve) => { releaseRead = resolve; });
  let executions = 0;
  let posts = 0;
  const current = { id: "job", kind: "agent.task", status: "running", attempts: 2, claim_token: "new", payload: { prompt: "work" } };
  worker.request = async (route) => {
    if (route.endsWith("/heartbeat")) return {};
    if (route === "/v1/jobs/job") { startedRead(); return slowRead; }
    if (route.endsWith("/claim")) return { job: current };
    if (route.endsWith("/complete")) {
      if (++posts === 1) throw new Error("upload lost");
      return {};
    }
    return {};
  };
  worker.runAgentTask = async () => ({ stdout: String(++executions) });
  const heartbeat = worker.heartbeat();
  await reading;
  await assert.rejects(worker.handleJob({ id: "job" }), /upload lost/);
  releaseRead({ job: { ...current, status: "queued", attempts: 1, claim_token: null } });
  await heartbeat;
  assert.equal(worker.jobOutcomes.get("job").claimToken, "new");
  await worker.handleJob({ id: "job" });
  assert.equal(executions, 1);
});

test("cancellation during a claim prevents the task from starting", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host" });
  worker.request = async () => {
    worker.handleEvent({ event: "job.cancelled", data: { id: "job" } });
    return { job: { id: "job", kind: "agent.task", claim_token: "claim", payload: { prompt: "cancelled" } } };
  };
  worker.runAgentTask = async () => assert.fail("cancelled task started");
  await worker.handleJob({ id: "job" });
});

test("a delayed creation event cannot abort an already claimed job", () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host" });
  const controller = new AbortController();
  worker.activeJobs.add("job");
  worker.jobControllers.set("job", { controller, attempts: 1, claimToken: "claim" });
  worker.handleEvent({ event: "job.created", data: { id: "job", target_agent: "worker", status: "queued", attempts: 0 } });
  assert.equal(controller.signal.aborted, false);
  assert.equal(worker.pendingWork.size, 0);
});

test("heartbeat catches cancellation missed by the event stream", async () => {
  const worker = new Worker({ serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex" });
  const job = { id: "job", kind: "agent.task", claim_token: "claim", payload: { prompt: "slow" } };
  worker.request = async (route) => route.endsWith("/claim") ? { job }
    : route === "/v1/jobs/job" ? { job: { ...job, status: "cancelled" } } : {};
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let cancelled = false;
  worker.runAgentTask = async (payload, { signal }) => {
    started();
    try { await delay(10_000, null, { signal }); }
    finally { cancelled = signal.aborted; }
  };
  const handling = worker.handleJob({ id: "job" });
  await running;
  await worker.heartbeat();
  await handling;
  assert.equal(cancelled, true);
});

test("aborting a process also terminates its subprocesses", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-process-tree-"));
  const marker = path.join(root, "state");
  const descendantPath = path.join(root, "descendant.mjs");
  let descendantPid;
  t.after(async () => {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* The subprocess already exited. */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(descendantPath, `import fs from "node:fs";
process.on("SIGTERM", () => { fs.writeFileSync(process.argv[2], "terminated"); process.exit(0); });
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));
spawn(process.execPath, process.argv.slice(1), { stdio: "ignore" });
setInterval(() => {}, 1000);`, descendantPath, marker], { signal: controller.signal, timeoutMs: 3000 });
  const rejected = assert.rejects(running, /was aborted/);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    descendantPid = await readFile(marker, "utf8").then(Number).catch(() => null);
    if (descendantPid) break;
    await delay(10);
  }
  assert.ok(descendantPid, "subprocess did not start");
  controller.abort();
  await rejected;
  assert.equal(await readFile(marker, "utf8"), "terminated");
});

test("a process aborted before starting never executes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-preabort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "started");
  await assert.rejects(runProcess(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker], {
    signal: AbortSignal.abort()
  }), /was aborted/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("shutdown closes pipes held by detached descendants", { skip: process.platform === "win32", timeout: 8000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-detached-pipes-"));
  const pidFile = path.join(root, "descendant.pid");
  const command = path.join(root, "agent.mjs");
  const worker = new Worker({
    serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex", command,
    logger: { log() {}, error() {} }
  });
  t.after(async () => {
    const pid = await readFile(pidFile, "utf8").then(Number).catch(() => null);
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* The descendant already exited. */ }
    }
    await worker.stop();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(command, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
descendant.unref();
setInterval(() => {}, 1000);`, { mode: 0o700 });
  const job = { id: "job", kind: "agent.task", attempts: 1, claim_token: "claim", payload: { prompt: "work" } };
  worker.request = async () => ({ job });
  worker.enqueueWork("job", job);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await readFile(pidFile, "utf8").catch(() => null)) break;
    await delay(10);
  }
  assert.ok(Number(await readFile(pidFile, "utf8")));
  let deadline;
  try {
    await Promise.race([
      worker.stop(),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("detached output pipes blocked worker shutdown")), 2500);
      })
    ]);
  } finally { clearTimeout(deadline); }
  assert.equal(worker.activeJobs.size, 0);
});

test("detached output pipes cannot block process exit or timeout", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  for (const mode of ["success", "timeout"]) await t.test(mode, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-detached-exit-"));
    const pidFile = path.join(root, "descendant.pid");
    const controller = new AbortController();
    let settled;
    let deadline;
    t.after(async () => {
      clearTimeout(deadline);
      controller.abort();
      const pid = await readFile(pidFile, "utf8").then(Number).catch(() => null);
      if (pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* The descendant already exited. */ }
      }
      await settled;
      await rm(root, { recursive: true, force: true });
    });
    const parent = `
const fs = require("node:fs");
const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  detached: true, stdio: ["ignore", "inherit", "inherit"]
});
fs.writeFileSync(process.argv[1], String(descendant.pid));
descendant.unref();
if (${JSON.stringify(mode)} === "success") {
  process.stdout.write("completed");
  process.exit(0);
}
setInterval(() => {}, 1000);`;
    settled = runProcess(process.execPath, ["-e", parent, pidFile], {
      signal: controller.signal, timeoutMs: mode === "timeout" ? 1000 : 5000
    }).then(result => ({ result }), error => ({ error }));
    const outcome = await Promise.race([
      settled,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("detached output pipes blocked process settlement")), 3000);
      })
    ]);
    if (mode === "timeout") assert.match(outcome.error?.message ?? "", /timed out after 1000ms/);
    else {
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.result.stdout, "completed");
      assert.equal(outcome.result.stdout_truncated, true);
      assert.equal(outcome.result.stderr_truncated, true);
    }
  });
});

test("process output preserves UTF-8 characters split across chunks", async () => {
  const result = await runProcess(process.execPath, ["-e", `
process.stdout.write(Buffer.from([0xe2]));
setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 20);`], { timeoutMs: 3000 });
  assert.equal(result.stdout, "€");
});

test("process capture bounds JSON-escaped output without splitting Unicode", async () => {
  const result = await runProcess(process.execPath, ["-e", `
process.stdout.write("\\u0001".repeat(128_000));
process.stderr.write("😀".repeat(100_000));`], { timeoutMs: 3000 });
  assert.ok(Buffer.byteLength(JSON.stringify(result.stdout)) < 256_010);
  assert.ok(Buffer.byteLength(JSON.stringify(result.stderr)) < 256_010);
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stderr_truncated, true);
  assert.equal(result.stderr, "😀".repeat(result.stderr.length / 2));
  const reply = { payload: { body: result.stdout, result } };
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 1_048_576);
});

test("task process completion stops descendants on success and failure", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
  for (const code of [0, 1]) {
    for (const stdio of ["ignore", "inherit"]) {
      await t.test(`exit ${code}, ${stdio}`, async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-completed-process-"));
        const descendantPath = path.join(root, "descendant.mjs");
        const marker = path.join(root, "ticks");
        const pidFile = path.join(root, "pid");
        t.after(async () => {
          const pid = await readFile(pidFile, "utf8").then(Number).catch(() => null);
          if (pid) {
            try { process.kill(pid, "SIGKILL"); } catch { /* The descendant already exited. */ }
          }
          await rm(root, { recursive: true, force: true });
        });
        await writeFile(descendantPath, `import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(process.argv[3], String(process.pid));
setInterval(() => fs.appendFileSync(process.argv[2], "tick"), 5);`);
        const running = runProcess(process.execPath, ["-e", `
const fs = require("node:fs");
require("node:child_process").spawn(process.execPath, process.argv.slice(1, 4), { stdio: process.argv[4] });
setInterval(() => {
  if (fs.existsSync(process.argv[2])) {
    process.stdout.write("completed");
    process.exit(Number(process.argv[5]));
  }
}, 5);`, descendantPath, marker, pidFile, stdio, String(code)], { timeoutMs: 2000 });
        if (code === 0) {
          const result = await running;
          assert.equal(result.code, 0);
          assert.equal(result.stdout, "completed");
        } else {
          await assert.rejects(running, /exited with code 1/);
        }
        await delay(30);
        const stopped = await readFile(marker, "utf8");
        await delay(80);
        assert.equal(await readFile(marker, "utf8"), stopped);
      });
    }
  }
});

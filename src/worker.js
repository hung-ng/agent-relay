import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import { runProbe } from "./probes.js";
import { requestJson } from "./http.js";
import { normalizeCapabilities } from "./routing.js";

const MAX_PROCESS_OUTPUT = 128_000;
const MAX_ENCODED_OUTPUT = 256_000;
const EVENT_CONNECT_TIMEOUT_MS = 30_000;
const EVENT_IDLE_TIMEOUT_MS = 45_000;
const MAX_EVENT_BUFFER = 2_097_152;

export class Worker {
  constructor({ serverUrl, agentId, hostId, kind = "probe", capabilities = ["network.probe"], token = "", command = null, cwd = process.cwd(), allowWrite = false, taskTimeoutMs = 600_000, logger = console }) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.agentId = agentId;
    this.hostId = hostId;
    this.kind = kind;
    this.capabilities = normalizeCapabilities(capabilities);
    this.token = token;
    this.command = command;
    this.cwd = cwd;
    this.allowWrite = allowWrite || this.capabilities.includes("agent.task.write");
    this.taskTimeoutMs = normalizeTaskTimeout(taskTimeoutMs);
    this.logger = logger;
    this.stopped = false;
    this.abortController = new AbortController();
    this.activeMessages = new Set();
    this.activeJobs = new Set();
    this.jobControllers = new Map();
    this.jobOutcomes = new Map();
    this.messageReplies = new Map();
    this.pendingWork = new Map();
    this.drainPromise = null;
    this.reconnectDelayMs = 1000;
  }

  async start() {
    await this.register();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((error) => { if (!this.stopped) this.logger.error(error); });
      this.reconcileWork().catch((error) => { if (!this.stopped) this.logger.error(error); });
    }, 15000);
    this.connectionPromise = this.connectEvents();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    this.abortController.abort();
    this.pendingWork.clear();
    await Promise.allSettled([this.connectionPromise, this.heartbeatPromise, this.reconciliationPromise, this.replayPromise, this.drainPromise]);
  }

  async register() {
    await this.request("/v1/agents/register", {
      method: "POST",
      body: {
        id: this.agentId,
        host_id: this.hostId,
        kind: this.kind,
        capabilities: this.capabilities
      }
    });
  }

  async heartbeat() {
    await this.sendHeartbeat();
    await this.reconcileWork();
  }

  sendHeartbeat() {
    if (this.stopped) return Promise.resolve();
    if (!this.heartbeatPromise) {
      this.heartbeatPromise = (async () => {
        try {
          await this.request(`/v1/agents/${encodeURIComponent(this.agentId)}/heartbeat`, { method: "POST" });
        } catch (error) {
          if (error.status !== 404) throw error;
          await this.register();
        }
      })().finally(() => { this.heartbeatPromise = null; });
    }
    return this.heartbeatPromise;
  }

  reconcileWork() {
    if (this.stopped) return Promise.resolve();
    if (!this.reconciliationPromise) {
      this.reconciliationPromise = this.reconcile().finally(() => { this.reconciliationPromise = null; });
    }
    return this.reconciliationPromise;
  }

  async reconcile() {
    for (const [id, active] of this.jobControllers) {
      if (active.attempts === Infinity) continue;
      try {
        const { job } = await this.request(`/v1/jobs/${encodeURIComponent(id)}`);
        if (job.status !== "running" || job.claim_token !== active.claimToken || job.attempts !== active.attempts) active.controller.abort();
      } catch (error) {
        if (error.status === 404) active.controller.abort();
        else throw error;
      }
    }
    for (const [id, outcome] of this.jobOutcomes) {
      try {
        const { job } = await this.request(`/v1/jobs/${encodeURIComponent(id)}`);
        if (this.jobOutcomes.get(id) === outcome && (job.status !== "running" || job.claim_token !== outcome.claimToken || job.attempts !== outcome.attempts)) this.jobOutcomes.delete(id);
      } catch (error) {
        if (error.status === 404) {
          if (this.jobOutcomes.get(id) === outcome) this.jobOutcomes.delete(id);
        }
        else throw error;
      }
    }
    for (const id of this.messageReplies.keys()) this.enqueueWork("message", { id });
    await this.replayPending();
  }

  async connectEvents() {
    while (!this.stopped) {
      let response;
      let connectTimer;
      let connectController;
      try {
        await this.register();
        connectController = new AbortController();
        connectTimer = setTimeout(() => connectController.abort(), EVENT_CONNECT_TIMEOUT_MS);
        response = await fetch(`${this.serverUrl}/v1/events?agent_id=${encodeURIComponent(this.agentId)}`, {
          headers: this.headers(),
          signal: AbortSignal.any([this.abortController.signal, connectController.signal])
        });
        clearTimeout(connectTimer);
        connectTimer = null;
        if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`);
        this.reconnectDelayMs = 1000;
        this.replayPending().catch((error) => {
          if (!this.stopped) this.logger.error(`agent-relay pending replay failed: ${error.message}`);
        });
        await this.consumeEvents(response.body);
        if (!this.stopped) throw new Error("event stream closed");
      } catch (error) {
        if (!this.stopped) {
          this.logger.error(`agent-relay connection lost: ${error.message}`);
          await delay(this.reconnectDelayMs, null, { signal: this.abortController.signal }).catch(() => {});
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        }
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
        try {
          await response?.body?.cancel?.();
        } catch {
          // The connection is already closed.
        }
      }
    }
  }

  async consumeEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let idleTimer;
    const onAbort = () => { reader.cancel().catch(() => {}); };
    this.abortController.signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!this.stopped) {
        let idle = false;
        idleTimer = setTimeout(() => { idle = true; reader.cancel().catch(() => {}); }, EVENT_IDLE_TIMEOUT_MS);
        const { value, done } = await reader.read();
        clearTimeout(idleTimer);
        if (idle) throw new Error("event stream stopped sending keep-alives");
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const raw = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (raw.length > MAX_EVENT_BUFFER) throw new Error("event exceeds the worker buffer limit");
          const event = parseEvent(raw);
          if (event) this.handleEvent(event);
        }
        if (buffer.length > MAX_EVENT_BUFFER) throw new Error("event exceeds the worker buffer limit");
      }
    } finally {
      clearTimeout(idleTimer);
      this.abortController.signal.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  replayPending() {
    if (this.stopped) return Promise.resolve();
    if (!this.replayPromise) {
      this.replayPromise = this.readPending().finally(() => { this.replayPromise = null; });
    }
    return this.replayPromise;
  }

  async readPending() {
    const pending = await this.request(`/v1/pending?agent_id=${encodeURIComponent(this.agentId)}&limit=200`);
    for (const message of pending.messages ?? []) this.enqueueWork("message", message);
    for (const job of pending.jobs ?? []) this.enqueueWork("job", job);
  }

  handleEvent({ event, data }) {
    if (!data || typeof data !== "object") return;
    if ((event === "job.created" || event === "job.queued") && data.target_agent === this.agentId) {
      const active = this.jobControllers.get(data.id);
      if (active && data.status === "queued" && data.attempts >= active.attempts) active.controller.abort();
      this.enqueueWork("job", data);
    }
    if (["job.cancelled", "job.failed", "job.completed"].includes(event)) {
      this.pendingWork.delete(`job:${data.id}`);
      this.jobOutcomes.delete(data.id);
      this.jobControllers.get(data.id)?.controller.abort();
    }
    if (event === "message.created" && data.recipient === this.agentId) this.enqueueWork("message", data);
  }

  enqueueWork(type, item) {
    if (this.stopped || !item?.id) return;
    if (type === "message" && this.activeMessages.has(item.id)) return;
    if (type === "job" && this.activeJobs.has(item.id) && !this.jobControllers.get(item.id)?.controller.signal.aborted) return;
    this.pendingWork.set(`${type}:${item.id}`, { type, item });
    this.startDrain();
  }

  startDrain() {
    if (this.drainPromise) return;
    this.drainPromise = this.drainQueue().finally(() => {
      this.drainPromise = null;
      if (!this.stopped && this.pendingWork.size > 0) this.startDrain();
    });
  }

  async drainQueue() {
    while (!this.stopped && this.pendingWork.size > 0) {
      const [key, { type, item }] = this.pendingWork.entries().next().value;
      this.pendingWork.delete(key);
      try {
        if (type === "job") await this.handleJob(item);
        else await this.handleMessage(item);
      } catch (error) {
        if (!this.stopped) this.logger.error(`agent-relay ${type} ${item.id}: ${error.message}`);
      }
    }
  }

  async handleMessage(message) {
    if (this.stopped || this.activeMessages.has(message.id)) return;
    this.activeMessages.add(message.id);
    try {
      const delivery = await this.request(`/v1/messages/${encodeURIComponent(message.id)}/deliver`, { method: "POST" });
      if (delivery.message?.status === "acknowledged") {
        this.messageReplies.delete(message.id);
        return;
      }
      message = delivery.message ?? message;
      const body = message.payload?.body ?? JSON.stringify(message.payload);
      const replyId = `reply:${message.id}`;
      this.logger.log(`[${this.agentId}] message from ${message.sender}: ${body}`);
      if ((this.kind === "claude" || this.kind === "codex") && ["message", "request", "task"].includes(message.type)) {
        let reply = this.messageReplies.get(message.id);
        if (!reply) {
          let payload;
          try {
            const result = await this.runAgentTask({ prompt: body });
            payload = { body: result.stdout || "", result };
          } catch (error) {
            payload = { body: `Agent failed: ${error.message}`, error: error.message };
          }
          reply = {
            id: replyId, sender: this.agentId, recipient: message.sender, type: "reply",
            conversation_id: message.conversation_id, payload
          };
          this.messageReplies.set(message.id, reply);
        }
        try { await this.request("/v1/messages", { method: "POST", body: reply }); }
        catch (error) {
          if (![400, 413, 422].includes(error.status)) throw error;
          const failure = `worker could not deliver its reply: HTTP ${error.status}`;
          reply = { ...reply, payload: { body: failure, error: failure } };
          this.messageReplies.set(message.id, reply);
          await this.request("/v1/messages", { method: "POST", body: reply });
        }
      }
      await this.request(`/v1/messages/${encodeURIComponent(message.id)}/ack`, { method: "POST" });
      this.messageReplies.delete(message.id);
    } finally {
      this.activeMessages.delete(message.id);
    }
  }

  async handleJob(job) {
    if (this.stopped || this.activeJobs.has(job.id)) return;
    this.activeJobs.add(job.id);
    const controller = new AbortController();
    const active = { controller, claimToken: null, attempts: Infinity };
    this.jobControllers.set(job.id, active);
    const signal = AbortSignal.any([this.abortController.signal, controller.signal]);
    try {
      let claimed;
      try {
        claimed = await this.request(`/v1/jobs/${encodeURIComponent(job.id)}/claim`, {
          method: "POST",
          body: { agent_id: this.agentId, claim_token_version: 1 }
        });
      } catch (error) {
        if ([404, 409].includes(error.status)) {
          this.jobOutcomes.delete(job.id);
          return;
        }
        throw error;
      }
      if (!claimed.job) return;
      job = claimed.job;
      active.claimToken = job.claim_token;
      active.attempts = job.attempts;
      if (signal.aborted) return;
      let outcome = this.jobOutcomes.get(job.id);
      if (outcome?.claimToken !== job.claim_token || outcome?.attempts !== job.attempts) outcome = null;
      if (!outcome) {
        let action = "complete";
        let body;
        try {
          let result;
          if (job.kind === "network.probe") result = await runProbe(job.payload, { signal });
          else if (job.kind === "agent.task") result = await this.runAgentTask(job.payload, { signal });
          else throw new Error(`unsupported job kind: ${job.kind}`);
          body = { result, claim_token: job.claim_token };
        } catch (error) {
          if (signal.aborted) return;
          action = "fail";
          body = { error: error.message, claim_token: job.claim_token };
        }
        outcome = { action, body, claimToken: job.claim_token, attempts: job.attempts };
        this.jobOutcomes.set(job.id, outcome);
      }
      if (!signal.aborted) {
        try {
          await this.request(`/v1/jobs/${encodeURIComponent(job.id)}/${outcome.action}`, {
            method: "POST", body: outcome.body
          });
        } catch (error) {
          if (![400, 413, 422].includes(error.status)) throw error;
          outcome = {
            action: "fail", claimToken: job.claim_token, attempts: job.attempts,
            body: { error: `worker could not deliver its result: HTTP ${error.status}`, retryable: false, claim_token: job.claim_token }
          };
          this.jobOutcomes.set(job.id, outcome);
          await this.request(`/v1/jobs/${encodeURIComponent(job.id)}/fail`, { method: "POST", body: outcome.body });
        }
      }
      if (this.jobOutcomes.get(job.id) === outcome) this.jobOutcomes.delete(job.id);
    } finally {
      this.activeJobs.delete(job.id);
      this.jobControllers.delete(job.id);
    }
  }

  async runAgentTask(payload, { signal = this.abortController.signal } = {}) {
    const prompt = String(payload?.prompt ?? "");
    if (!prompt) throw new Error("agent.task requires payload.prompt");
    if (payload?.execution_mode === "write" && !this.allowWrite) {
      throw new Error("write workflow requires an agent.task.write capability");
    }
    const command = this.command ?? this.kind;
    const args = agentTaskArgs(this.kind, { ...payload, allow_write: this.allowWrite });
    return runProcess(command, args, {
      input: prompt,
      cwd: payload.cwd ?? this.cwd,
      timeoutMs: normalizeTaskTimeout(payload.task_timeout_ms ?? this.taskTimeoutMs),
      signal
    });
  }

  async request(path, { method = "GET", body } = {}) {
    return requestJson(`${this.serverUrl}${path}`, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body,
      signal: this.abortController.signal
    });
  }

  headers() {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      "x-agent-id": this.agentId
    };
  }
}

export function agentTaskArgs(command, payload = {}) {
  const mode = payload.execution_mode ?? "default";
  if (!["default", "read_only", "write"].includes(mode)) throw new Error(`unknown execution mode: ${mode}`);
  if (mode === "write" && !payload.allow_write) throw new Error("write workflow requires an agent.task.write capability");
  if (command === "claude") {
    if (mode !== "default") throw new Error("workflow execution modes require a codex worker");
    return ["-p", "--output-format", "json", "--permission-mode", "dontAsk"];
  }
  if (command !== "codex") throw new Error(`unsupported agent kind: ${command}`);
  return [
    "exec",
    "--sandbox", mode === "write" ? "workspace-write" : "read-only",
    "--config", 'approval_policy="never"',
    "-"
  ];
}

function parseEvent(raw) {
  let event = "message";
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}

export function runProcess(command, args, { timeoutMs, signal, input, ...spawnOptions } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(`${command} was aborted`));
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { ...spawnOptions, detached: grouped, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stdout = captureOutput();
    const stderr = captureOutput();
    let timedOut = false;
    let stopping = false;
    let inputError;
    let killTimer;
    const normalizedTimeoutMs = Number(timeoutMs);
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(signal);
      }
    };
    const stopChild = () => {
      if (stopping) return;
      stopping = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
    };
    const timeout = Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        stopChild();
      }, normalizedTimeoutMs)
      : null;
    if (signal) {
      if (signal.aborted) stopChild();
      else signal.addEventListener("abort", stopChild, { once: true });
    }
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", stopChild);
    };
    child.stdout.on("data", (chunk) => stdout.append(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk) => stderr.append(stderrDecoder.write(chunk)));
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) kill("SIGKILL");
    });
    child.on("close", (code, signal) => {
      if (stopping) kill("SIGKILL");
      cleanup();
      stdout.append(stdoutDecoder.end());
      stderr.append(stderrDecoder.end());
      if (timedOut) {
        reject(new Error(`${command} timed out after ${normalizedTimeoutMs}ms`));
      } else if (inputError) {
        reject(inputError);
      } else if (stopping) {
        reject(new Error(`${command} was aborted`));
      } else if (code === 0) {
        resolve({ command, args, code, signal, stdout: stdout.text, stderr: stderr.text, stdout_truncated: stdout.truncated, stderr_truncated: stderr.truncated });
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${stderr.text || stdout.text}`));
      }
    });
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          inputError = error;
          stopChild();
        }
      });
      child.stdin.end(input);
    }
  });
}

function captureOutput() {
  return {
    text: "", encodedBytes: 0, truncated: false,
    append(chunk) {
      if (!chunk) return;
      if (this.truncated) return;
      let end = safeTextEnd(chunk, Math.min(chunk.length, MAX_PROCESS_OUTPUT - this.text.length));
      const available = MAX_ENCODED_OUTPUT - this.encodedBytes;
      const encodedSize = (length) => Buffer.byteLength(JSON.stringify(chunk.slice(0, safeTextEnd(chunk, length)))) - 2;
      if (encodedSize(end) > available) {
        let low = 0, high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (encodedSize(middle) <= available) low = middle;
          else high = middle - 1;
        }
        end = safeTextEnd(chunk, low);
      }
      this.encodedBytes += encodedSize(end);
      this.text += chunk.slice(0, end);
      if (end < chunk.length) this.truncated = true;
    }
  };
}

function safeTextEnd(text, end) {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1;
  return end;
}

function normalizeTaskTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 600_000;
  return Math.min(Math.max(Math.floor(parsed), 1), 86_400_000);
}

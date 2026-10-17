import { spawn } from "node:child_process";
import { runProbe } from "./probes.js";
import { requestJson } from "./http.js";

export class Worker {
  constructor({ serverUrl, agentId, hostId, kind = "probe", capabilities = ["network.probe"], token = "", command = null, cwd = process.cwd(), allowWrite = false, logger = console }) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.agentId = agentId;
    this.hostId = hostId;
    this.kind = kind;
    this.capabilities = capabilities;
    this.token = token;
    this.command = command;
    this.cwd = cwd;
    this.allowWrite = allowWrite || capabilities.includes("agent.task.write");
    this.logger = logger;
    this.stopped = false;
    this.abortController = new AbortController();
    this.activeMessages = new Set();
    this.activeJobs = new Set();
    this.reconnectDelayMs = 1000;
  }

  async start() {
    await this.register();
    this.heartbeatTimer = setInterval(() => this.heartbeat().catch((error) => this.logger.error(error)), 15000);
    this.connectEvents();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    this.abortController.abort();
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
    await this.request(`/v1/agents/${encodeURIComponent(this.agentId)}/heartbeat`, { method: "POST" });
  }

  async connectEvents() {
    while (!this.stopped) {
      let response;
      try {
        response = await fetch(`${this.serverUrl}/v1/events?agent_id=${encodeURIComponent(this.agentId)}`, {
          headers: this.headers(),
          signal: this.abortController.signal
        });
        if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`);
        this.reconnectDelayMs = 1000;
        await this.replayPending();
        await this.consumeEvents(response.body);
        if (!this.stopped) throw new Error("event stream closed");
      } catch (error) {
        if (!this.stopped) {
          this.logger.error(`agent-relay connection lost: ${error.message}`);
          await delay(this.reconnectDelayMs);
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        }
      } finally {
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
    while (!this.stopped) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEvent(raw);
        if (event?.event === "job.created" || event?.event === "job.queued") await this.handleJob(event.data);
        if (event?.event === "message.created") await this.handleMessage(event.data);
      }
    }
  }

  async replayPending() {
    const pending = await this.request(`/v1/pending?agent_id=${encodeURIComponent(this.agentId)}`);
    for (const message of pending.messages ?? []) await this.handleMessage(message);
    for (const job of pending.jobs ?? []) await this.handleJob(job);
  }

  async handleMessage(message) {
    if (this.activeMessages.has(message.id)) return;
    this.activeMessages.add(message.id);
    try {
      const delivery = await this.request(`/v1/messages/${encodeURIComponent(message.id)}/deliver`, { method: "POST" });
      if (delivery.message?.status === "acknowledged") return;
      const body = message.payload?.body ?? JSON.stringify(message.payload);
      this.logger.log(`[${this.agentId}] message from ${message.sender}: ${body}`);
      if ((this.kind === "claude" || this.kind === "codex") && ["message", "request", "task"].includes(message.type)) {
        try {
          const result = await this.runAgentTask({ prompt: body });
          await this.request("/v1/messages", {
            method: "POST",
            body: {
              sender: this.agentId,
              recipient: message.sender,
              type: "reply",
              conversation_id: message.conversation_id,
              payload: { body: result.stdout || "", result }
            }
          });
        } catch (error) {
          await this.request("/v1/messages", {
            method: "POST",
            body: {
              sender: this.agentId,
              recipient: message.sender,
              type: "reply",
              conversation_id: message.conversation_id,
              payload: { body: `Agent failed: ${error.message}`, error: error.message }
            }
          });
        }
      }
      await this.request(`/v1/messages/${encodeURIComponent(message.id)}/ack`, { method: "POST" });
    } finally {
      this.activeMessages.delete(message.id);
    }
  }

  async handleJob(job) {
    if (this.activeJobs.has(job.id)) return;
    this.activeJobs.add(job.id);
    try {
      let claimed;
      try {
        claimed = await this.request(`/v1/jobs/${encodeURIComponent(job.id)}/claim`, {
          method: "POST",
          body: { agent_id: this.agentId }
        });
      } catch (error) {
        if (error.status === 409) return;
        throw error;
      }
      if (!claimed.job) return;
      try {
        let result;
        if (job.kind === "network.probe") result = await runProbe(job.payload);
        else if (job.kind === "agent.task") result = await this.runAgentTask(job.payload);
        else throw new Error(`unsupported job kind: ${job.kind}`);
        await this.request(`/v1/jobs/${encodeURIComponent(job.id)}/complete`, { method: "POST", body: { result } });
      } catch (error) {
        await this.request(`/v1/jobs/${encodeURIComponent(job.id)}/fail`, { method: "POST", body: { error: error.message } });
      }
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  async runAgentTask(payload) {
    const prompt = String(payload?.prompt ?? "");
    if (!prompt) throw new Error("agent.task requires payload.prompt");
    if (payload?.execution_mode === "write" && !this.allowWrite) {
      throw new Error("write workflow requires an agent.task.write capability");
    }
    const command = this.command ?? this.kind;
    const args = agentTaskArgs(command, { ...payload, allow_write: this.allowWrite });
    return runProcess(command, args, { cwd: payload.cwd ?? this.cwd });
  }

  async request(path, { method = "GET", body } = {}) {
    return requestJson(`${this.serverUrl}${path}`, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body
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
  if (command === "claude") return ["-p", String(payload.prompt ?? ""), "--output-format", "json"];
  return [
    "exec",
    ...(payload.execution_mode === "read_only"
      ? ["--sandbox", "read-only", "--config", 'approval_policy="never"']
      : payload.execution_mode === "write" && payload.allow_write
        ? ["--sandbox", "workspace-write", "--config", 'approval_policy="never"']
        : []),
    String(payload.prompt ?? "")
  ];
}

function parseEvent(raw) {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { event, data: JSON.parse(data) };
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ command, args, code, signal, stdout: stdout.slice(0, 128_000), stderr: stderr.slice(0, 128_000) });
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${stderr || stdout}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

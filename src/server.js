import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { createMcpHandler } from "./mcp.js";
import { dispatchJob } from "./jobs.js";
import { readJsonBody } from "./body.js";

const MAX_EVENT_QUEUE_BYTES = 2_097_152;

export function createServer({
  dbPath = "./data/agent-relay.db",
  token = process.env.AGENT_RELAY_TOKEN ?? "",
  previousToken = process.env.AGENT_RELAY_PREVIOUS_TOKEN ?? ""
} = {}) {
  const authenticate = createAuthenticator(token, previousToken);
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 });
  const store = new Store(dbPath);
  const subscribers = new Map();
  const refreshStaleWork = () => {
    store.markStale();
    for (const job of store.requeueStaleJobs()) publishJobEvent(job);
  };
  const staleTimer = setInterval(refreshStaleWork, 15000);
  let closed = false;

  const publish = (agentId, event, data) => {
    const listeners = subscribers.get(agentId) ?? new Set();
    for (const response of listeners) {
      try {
        if (!writeEvent(response, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
          listeners.delete(response);
        }
      } catch {
        listeners.delete(response);
        try { response.end(); } catch { /* The peer already closed the stream. */ }
      }
    }
    if (listeners.size === 0) subscribers.delete(agentId);
  };

  const mcpHandler = createMcpHandler({ store, publish });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") return sendJson(response, 204, null);
      if (!authenticate(request)) return sendJson(response, 401, { error: "unauthorized" });
      const url = new URL(request.url, "http://localhost");

      if (url.pathname === "/healthz" && request.method === "GET") {
        return sendJson(response, 200, { ok: true, service: "agent-relay" });
      }
      if (url.pathname === "/readyz" && request.method === "GET") {
        store.checkReady();
        return sendJson(response, 200, { ok: true, service: "agent-relay" });
      }
      if (url.pathname === "/mcp") {
        if (request.method !== "POST") return sendJson(response, 405, { error: "method not allowed" }, { allow: "POST" });
        return await mcpHandler(request, response);
      }
      if (url.pathname === "/v1/events" && request.method === "GET") {
        const agentId = url.searchParams.get("agent_id");
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        if (actor !== agentId) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        return openEvents(agentId, request, response);
      }
      if (url.pathname === "/v1/agents" && request.method === "GET") {
        return sendJson(response, 200, { agents: store.listAgents() });
      }
      if (url.pathname === "/v1/agents/register" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isNonEmptyString(body.id) || !isNonEmptyString(body.host_id)) {
          return sendJson(response, 400, { error: "id and host_id are required" });
        }
        return sendJson(response, 200, { agent: store.registerAgent({
          id: body.id,
          hostId: body.host_id,
          kind: body.kind,
          capabilities: body.capabilities,
          metadata: body.metadata
        }) });
      }
      const heartbeat = url.pathname.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
      if (heartbeat && request.method === "POST") {
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const agentId = decodeURIComponent(heartbeat[1]);
        if (actor !== agentId) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        const agent = store.heartbeat(agentId);
        return agent ? sendJson(response, 200, { agent }) : sendJson(response, 404, { error: "agent not found" });
      }
      if (url.pathname === "/v1/messages" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isNonEmptyString(body.sender) || !isNonEmptyString(body.recipient) || !isOptionalId(body.id)) {
          return sendJson(response, 400, { error: "sender and recipient are required" });
        }
        const message = store.createMessage({
          id: body.id,
          sender: body.sender,
          recipient: body.recipient,
          type: body.type,
          conversationId: body.conversation_id,
          payload: body.payload ?? { body: body.body }
        });
        publish(message.recipient, "message.created", message);
        return sendJson(response, 201, { message });
      }
      if (url.pathname === "/v1/messages" && request.method === "GET") {
        const recipient = url.searchParams.get("agent_id");
        if (!recipient) return sendJson(response, 400, { error: "agent_id is required" });
        return sendJson(response, 200, { messages: store.getMessages(recipient, url.searchParams.get("limit")) });
      }
      if (url.pathname === "/v1/pending" && request.method === "GET") {
        const agentId = url.searchParams.get("agent_id");
        if (!agentId) return sendJson(response, 400, { error: "agent_id is required" });
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        if (actor !== agentId) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        return sendJson(response, 200, store.getPendingWork(agentId, url.searchParams.get("limit")));
      }
      const messageAction = url.pathname.match(/^\/v1\/messages\/([^/]+)\/(ack|deliver)$/);
      if (messageAction && request.method === "POST") {
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const id = decodeURIComponent(messageAction[1]);
        const message = messageAction[2] === "ack"
          ? store.acknowledgeMessageBy(id, actor)
          : store.markMessageDeliveredBy(id, actor);
        return message
          ? sendJson(response, 200, { message })
          : sendJson(response, 403, { error: "agent is not the message recipient" });
      }
      if (url.pathname === "/v1/jobs" && request.method === "POST") {
        const body = await readJsonBody(request);
        const job = dispatchJob({ store, publish }, body);
        return sendJson(response, 201, { job });
      }
      const jobRoute = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobRoute && request.method === "GET") {
        const job = store.getJob(decodeURIComponent(jobRoute[1]));
        return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: "job not found" });
      }
      const jobClaim = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/claim$/);
      if (jobClaim && request.method === "POST") {
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const body = await readJsonBody(request);
        if (body.agent_id !== actor) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        const id = decodeURIComponent(jobClaim[1]);
        const existing = store.getJob(id);
        if (!existing) return sendJson(response, 404, { error: "job not found" });
        if (!store.agentSupports(actor, existing.required_capability)) {
          return sendJson(response, 403, { error: "agent is offline or lacks the required capability" });
        }
        if (existing.target_agent && existing.target_agent !== actor) {
          return sendJson(response, 403, { error: "agent is not the job target" });
        }
        if (body.claim_token_version !== undefined && body.claim_token_version !== 1) {
          return sendJson(response, 400, { error: "unsupported claim_token_version" });
        }
        const job = store.claimJob(id, actor, { withToken: body.claim_token_version === 1 });
        return job ? sendJson(response, 200, { job }) : sendJson(response, 409, { error: "job is not available" });
      }
      const jobResult = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(complete|fail|cancel)$/);
      if (jobResult && request.method === "POST") {
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const id = decodeURIComponent(jobResult[1]);
        const action = jobResult[2];
        const body = await readJsonBody(request);
        if (action === "fail" && body.retryable !== undefined && typeof body.retryable !== "boolean") {
          return sendJson(response, 400, { error: "retryable must be a boolean" });
        }
        const existing = store.getJob(id);
        if (!existing) return sendJson(response, 404, { error: "job not found" });
        if (action === "cancel" && actor !== existing.requested_by && actor !== existing.target_agent) {
          return sendJson(response, 403, { error: "agent is not authorized for this job" });
        }
        if (action !== "cancel" && actor !== existing.target_agent && actor !== existing.claimed_by) {
          return sendJson(response, 403, { error: "agent is not authorized for this job" });
        }
        const job = action === "complete"
          ? store.completeJobBy(id, body.result, actor, body.claim_token)
          : action === "fail"
            ? store.failJobBy(id, body.error, actor, body.claim_token, { retryable: body.retryable })
            : store.cancelJob(id);
        if (!job) return sendJson(response, 409, { error: "job claim is no longer current" });
        publishJobEvent(job);
        return sendJson(response, 200, { job });
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const status = error instanceof URIError ? 400
        : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) console.error(error);
      return sendJson(response, status, { error: status === 500 ? "internal server error" : error.message });
    }
  });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const listeners of subscribers.values()) {
      for (const response of listeners) {
        try { response.end(); } catch { /* The peer already closed the stream. */ }
      }
    }
    clearInterval(staleTimer);
    store.close();
    if (server.listening) server.close();
  };

  refreshStaleWork();
  return { server, store, close };

  function publishJobEvent(job) {
    const event = job.status === "queued" ? "job.created" : `job.${job.status}`;
    for (const agentId of new Set([job.target_agent, job.requested_by].filter(Boolean))) publish(agentId, event, job);
  }

  function openEvents(agentId, request, response) {
    if (!agentId) return sendJson(response, 400, { error: "agent_id is required" });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    if (!writeEvent(response, `event: ready\ndata: ${JSON.stringify({ agent_id: agentId })}\n\n`)) return;
    if (!subscribers.has(agentId)) subscribers.set(agentId, new Set());
    subscribers.get(agentId).add(response);
    let keepAlive;
    const cleanup = () => {
      clearInterval(keepAlive);
      subscribers.get(agentId)?.delete(response);
      if (subscribers.get(agentId)?.size === 0) subscribers.delete(agentId);
    };
    keepAlive = setInterval(() => {
      try {
        if (!writeEvent(response, ": keep-alive\n\n")) {
          cleanup();
        }
      } catch { cleanup(); }
    }, 15000);
    request.on("close", cleanup);
    response.on("close", cleanup);
  }
}

function writeEvent(response, chunk) {
  if (response.destroyed || response.writableEnded) return false;
  if ((response.writableLength ?? 0) + Buffer.byteLength(chunk) > MAX_EVENT_QUEUE_BYTES) {
    response.destroy?.();
    return false;
  }
  response.write(chunk);
  return true;
}

function createAuthenticator(token, previousToken) {
  if (typeof token !== "string" || typeof previousToken !== "string") {
    throw new Error("relay authentication tokens must be strings");
  }
  if (previousToken && !token) throw new Error("AGENT_RELAY_PREVIOUS_TOKEN requires AGENT_RELAY_TOKEN");
  if (!token) return () => true;
  const digest = (value) => createHash("sha256").update(value).digest();
  const primary = digest(`Bearer ${token}`);
  const previous = previousToken ? digest(`Bearer ${previousToken}`) : null;
  return (request) => {
    const header = request.headers.authorization;
    if (typeof header !== "string") return false;
    const supplied = digest(header);
    const primaryMatches = timingSafeEqual(supplied, primary);
    const previousMatches = previous ? timingSafeEqual(supplied, previous) : false;
    return primaryMatches || previousMatches;
  };
}

function agentIdentity(request) {
  const value = request.headers["x-agent-id"];
  return typeof value === "string" && value ? value : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function isOptionalId(value) {
  return value === undefined || value === null || isNonEmptyString(value);
}

function sendJson(response, status, payload, extraHeaders = {}) {
  if (response.writableEnded || response.destroyed) return;
  const headers = { "content-type": "application/json; charset=utf-8", ...extraHeaders };
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

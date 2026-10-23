import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import {
  MAX_ENCODED_ID_LENGTH,
  MAX_ENCODED_REPLY_ID_LENGTH,
  normalizeRecordId,
  validateAgentId,
  validateIdentifier,
  validateRecordId
} from "./identifiers.js";
import {
  normalizeCapabilities,
  normalizeMetadata,
  supportsCapability
} from "./routing.js";

const now = () => new Date().toISOString();

export class Store {
  constructor(filename = "./data/agent-relay.db") {
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'online',
        last_seen TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'message',
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        required_capability TEXT,
        requested_by TEXT NOT NULL,
        target_agent TEXT,
        source_host TEXT,
        target_host TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        claimed_by TEXT,
        claim_token TEXT
      );

      CREATE INDEX IF NOT EXISTS messages_recipient_status
        ON messages(recipient, status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_status_created
        ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_target_status_created
        ON jobs(target_agent, status, created_at);
      CREATE INDEX IF NOT EXISTS agents_host
        ON agents(host_id, status);
    `);
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all();
    if (!jobColumns.some((column) => column.name === "required_capability")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN required_capability TEXT");
    }
    if (!jobColumns.some((column) => column.name === "attempts")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    }
    if (!jobColumns.some((column) => column.name === "max_attempts")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3");
    }
    if (!jobColumns.some((column) => column.name === "claim_token")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN claim_token TEXT");
    }
  }

  close() {
    this.db.close();
  }

  checkReady() {
    this.db.prepare("SELECT 1").get();
    return true;
  }

  registerAgent({ id, hostId, kind = "unknown", capabilities = [], metadata = {} }) {
    validateAgentId(id);
    validateIdentifier(hostId, "host_id");
    const timestamp = now();
    const normalizedKind = typeof kind === "string" && kind.trim() ? kind : "unknown";
    const normalizedCapabilities = normalizeCapabilities(capabilities);
    const normalizedMetadata = normalizeMetadata(metadata);
    this.db.prepare(`
      INSERT INTO agents (id, host_id, kind, capabilities, metadata, status, last_seen, created_at)
      VALUES (?, ?, ?, ?, ?, 'online', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        host_id = excluded.host_id,
        kind = excluded.kind,
        capabilities = excluded.capabilities,
        metadata = excluded.metadata,
        status = 'online',
        last_seen = excluded.last_seen
    `).run(id, hostId, normalizedKind, JSON.stringify(normalizedCapabilities), JSON.stringify(normalizedMetadata), timestamp, timestamp);
    return this.getAgent(id);
  }

  heartbeat(id) {
    validateAgentId(id);
    const timestamp = now();
    const result = this.db.prepare(
      "UPDATE agents SET status = 'online', last_seen = ? WHERE id = ?"
    ).run(timestamp, id);
    return result.changes > 0 ? this.getAgent(id) : null;
  }

  getAgent(id) {
    validateAgentId(id);
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? this.#agent(row) : null;
  }

  listAgents() {
    this.markStale();
    return this.db.prepare("SELECT * FROM agents ORDER BY id").all().map((row) => this.#agent(row));
  }

  findAgentForHost(hostId, capability, { kind = null } = {}) {
    validateIdentifier(hostId, "host_id");
    this.markStale();
    const rows = this.db.prepare(
      "SELECT * FROM agents WHERE host_id = ? AND status = 'online' AND (? IS NULL OR kind = ?) ORDER BY last_seen DESC"
    ).all(hostId, kind, kind);
    const match = rows.find((row) => {
      const capabilities = JSON.parse(row.capabilities);
      return supportsCapability(capabilities, capability);
    });
    return match ? this.#agent(match) : null;
  }

  agentSupports(agentId, capability) {
    validateAgentId(agentId);
    this.markStale();
    const agent = this.getAgent(agentId);
    return Boolean(agent && agent.status === "online" && supportsCapability(agent.capabilities, capability));
  }

  markStale(maxAgeMs = 45_000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.prepare(
      "UPDATE agents SET status = 'offline' WHERE status = 'online' AND last_seen < ?"
    ).run(cutoff).changes;
  }

  requeueStaleJobs() {
    // SQLite truncates legacy NUL IDs on read. Use row IDs for maintenance.
    const rows = this.db.prepare(`
      SELECT jobs.rowid AS store_rowid, jobs.*
      FROM jobs
      INNER JOIN agents ON agents.id = jobs.target_agent
      WHERE jobs.status = 'running' AND agents.status = 'offline'
      ORDER BY jobs.created_at ASC
    `).all();
    const jobs = [];
    for (const row of rows) {
      const existing = this.#job(row);
      const error = "target agent went offline before completing the job";
      const terminal = existing.attempts >= existing.max_attempts;
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = ?, error = ?, completed_at = ?, started_at = NULL, claimed_by = NULL, claim_token = NULL
        WHERE rowid = ? AND status = 'running' AND claim_token IS ? AND attempts = ?
          AND EXISTS (SELECT 1 FROM agents WHERE agents.id = jobs.target_agent AND agents.status = 'offline')
      `).run(terminal ? "failed" : "queued", error, terminal ? now() : null, row.store_rowid, existing.claim_token, existing.attempts);
      if (result.changes > 0) {
        const updated = this.db.prepare("SELECT *, CAST(id AS BLOB) AS store_id_bytes FROM jobs WHERE rowid = ?").get(row.store_rowid);
        // A lossy ID could notify a different job. Recover the row without publishing it.
        if (updated && Buffer.from(updated.id).equals(updated.store_id_bytes)) jobs.push(this.#job(updated));
      }
    }
    return jobs;
  }

  createMessage({ id, conversationId = null, sender, recipient, type = "message", payload }) {
    const messageId = normalizeRecordId(id, "message id", MAX_ENCODED_REPLY_ID_LENGTH);
    const existing = this.getMessage(messageId);
    if (existing) return existing;
    const normalizedType = typeof type === "string" && type.trim() ? type : "message";
    validateRecordId(messageId, "message id", normalizedType === "reply" ? MAX_ENCODED_REPLY_ID_LENGTH : MAX_ENCODED_ID_LENGTH);
    validateAgentId(sender, "sender");
    validateAgentId(recipient, "recipient");
    if (conversationId !== null) validateIdentifier(conversationId, "conversation_id");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO messages
        (id, conversation_id, sender, recipient, type, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
      ON CONFLICT(id) DO NOTHING
    `).run(messageId, conversationId, sender, recipient, normalizedType, JSON.stringify(payload ?? {}), timestamp);
    return this.getMessage(messageId);
  }

  getMessage(id) {
    validateRecordId(id, "message id", MAX_ENCODED_REPLY_ID_LENGTH);
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? this.#message(row) : null;
  }

  getMessages(recipient, limit = 50) {
    validateAgentId(recipient, "recipient");
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE recipient = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(recipient, normalizeLimit(limit));
    return rows.map((row) => this.#message(row));
  }

  getPendingMessages(recipient, limit = 50) {
    validateAgentId(recipient, "recipient");
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE recipient = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(recipient, normalizeLimit(limit));
    return rows.map((row) => this.#message(row));
  }

  getPendingWork(agentId, limit = 50) {
    validateAgentId(agentId);
    const boundedLimit = normalizeLimit(limit);
    const messages = this.db.prepare(`
      SELECT * FROM messages
      WHERE recipient = ? AND status IN ('queued', 'delivered')
      ORDER BY created_at ASC
      LIMIT ?
    `).all(agentId, boundedLimit).map((row) => this.#message(row));
    const jobs = this.db.prepare(`
      SELECT * FROM jobs
      WHERE target_agent = ? AND status IN ('queued', 'running')
      ORDER BY created_at ASC
      LIMIT ?
    `).all(agentId, boundedLimit).map((row) => this.#job(row));
    return { messages, jobs };
  }

  markMessageDelivered(id) {
    return this.#transitionMessage(id, null, "delivered");
  }

  markMessageDeliveredBy(id, agentId) {
    validateAgentId(agentId);
    return this.#transitionMessage(id, agentId, "delivered");
  }

  acknowledgeMessage(id) {
    return this.#transitionMessage(id, null, "acknowledged");
  }

  acknowledgeMessageBy(id, agentId) {
    validateAgentId(agentId);
    return this.#transitionMessage(id, agentId, "acknowledged");
  }

  #transitionMessage(id, agentId, status) {
    const message = this.getMessage(id);
    if (!message || (agentId && message.recipient !== agentId)) return null;
    if (status === "delivered" && ["queued", "delivered"].includes(message.status)) {
      this.db.prepare(
        "UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status IN ('queued', 'delivered')"
      ).run(now(), id);
    } else if (status === "acknowledged" && ["queued", "delivered"].includes(message.status)) {
      this.db.prepare(
        "UPDATE messages SET status = 'acknowledged', acknowledged_at = ? WHERE id = ? AND status IN ('queued', 'delivered')"
      ).run(now(), id);
    }
    return this.getMessage(id);
  }

  createJob({ id, kind, requiredCapability = null, maxAttempts = 3, requestedBy, targetAgent = null, sourceHost = null, targetHost = null, payload = {} }) {
    const jobId = normalizeRecordId(id, "job id");
    const existing = this.getJob(jobId);
    if (existing) return existing;
    validateAgentId(requestedBy, "requested_by");
    if (targetAgent !== null) validateAgentId(targetAgent, "target_agent");
    if (sourceHost !== null) validateIdentifier(sourceHost, "source_host");
    if (targetHost !== null) validateIdentifier(targetHost, "target_host");
    const timestamp = now();
    const parsedAttempts = Number(maxAttempts);
    const boundedAttempts = Number.isFinite(parsedAttempts) ? Math.min(Math.max(Math.floor(parsedAttempts) || 3, 1), 10) : 3;
    this.db.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, requested_by, target_agent, source_host, target_host, payload, status, attempts, max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(jobId, kind, requiredCapability, requestedBy, targetAgent, sourceHost, targetHost, JSON.stringify(payload ?? {}), boundedAttempts, timestamp);
    return this.getJob(jobId);
  }

  getJob(id) {
    validateRecordId(id, "job id");
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? this.#job(row) : null;
  }

  claimJob(id, agentId, { withToken = true } = {}) {
    validateRecordId(id, "job id");
    validateAgentId(agentId);
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'running', claimed_by = ?, started_at = ?, attempts = attempts + 1, claim_token = ?
      WHERE id = ? AND status = 'queued' AND (target_agent IS NULL OR target_agent = ?)
    `).run(agentId, timestamp, withToken ? randomUUID() : null, id, agentId);
    if (result.changes > 0) return this.getJob(id);
    const existing = this.getJob(id);
    return existing?.status === 'running' && existing.claimed_by === agentId ? existing : null;
  }

  completeJob(id, result) {
    return this.#finishJob(id, "completed", { result });
  }

  completeJobBy(id, result, agentId, claimToken = null) {
    validateAgentId(agentId);
    return this.#finishJob(id, "completed", { result }, agentId, claimToken);
  }

  failJob(id, error, { retryable = true } = {}) {
    return this.#finishJob(id, "failed", { error, retryable });
  }

  failJobBy(id, error, agentId, claimToken = null, { retryable = true } = {}) {
    validateAgentId(agentId);
    return this.#finishJob(id, "failed", { error, retryable }, agentId, claimToken);
  }

  #finishJob(id, status, values, agentId = null, claimToken = null) {
    if (claimToken !== null) validateIdentifier(claimToken, "claim_token");
    const existing = this.getJob(id);
    if (!existing || (agentId && existing.claimed_by !== agentId)) return null;
    if (agentId && existing.claim_token !== claimToken) return null;
    const timestamp = now();
    const claim = [id, existing.claim_token, existing.claimed_by, existing.attempts];
    if (status === "completed") {
      this.db.prepare(`
        UPDATE jobs SET status = 'completed', result = ?, error = NULL, completed_at = ?
        WHERE id = ? AND status = 'running' AND claim_token IS ? AND claimed_by IS ? AND attempts = ?
      `).run(JSON.stringify(values.result ?? {}), timestamp, ...claim);
    } else {
      const terminal = values.retryable === false || existing.attempts >= existing.max_attempts;
      const error = String(values.error ?? "job failed");
      if (terminal) {
        this.db.prepare(`
          UPDATE jobs SET status = 'failed', error = ?, completed_at = ?
          WHERE id = ? AND status = 'running' AND claim_token IS ? AND claimed_by IS ? AND attempts = ?
        `).run(error, timestamp, ...claim);
      } else {
        this.db.prepare(`
          UPDATE jobs SET status = 'queued', error = ?, completed_at = NULL, started_at = NULL, claimed_by = NULL, claim_token = NULL
          WHERE id = ? AND status = 'running' AND claim_token IS ? AND claimed_by IS ? AND attempts = ?
        `).run(error, ...claim);
      }
    }
    const current = this.getJob(id);
    if (current?.attempts !== existing.attempts) return null;
    if (current?.status === "running" && current.claim_token !== existing.claim_token) return null;
    return current;
  }

  cancelJob(id) {
    validateRecordId(id, "job id");
    const timestamp = now();
    this.db.prepare(`
      UPDATE jobs SET status = 'cancelled', completed_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(timestamp, id);
    return this.getJob(id);
  }

  #agent(row) {
    return {
      id: row.id,
      host_id: row.host_id,
      kind: row.kind,
      capabilities: JSON.parse(row.capabilities),
      metadata: JSON.parse(row.metadata),
      status: row.status,
      last_seen: row.last_seen,
      created_at: row.created_at
    };
  }

  #message(row) {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      sender: row.sender,
      recipient: row.recipient,
      type: row.type,
      payload: JSON.parse(row.payload),
      status: row.status,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
      acknowledged_at: row.acknowledged_at
    };
  }

  #job(row) {
    return {
      id: row.id,
      kind: row.kind,
      required_capability: row.required_capability,
      requested_by: row.requested_by,
      target_agent: row.target_agent,
      source_host: row.source_host,
      target_host: row.target_host,
      payload: JSON.parse(row.payload),
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      claimed_by: row.claimed_by,
      claim_token: row.claim_token
    };
  }
}

function normalizeLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed) || 50, 1), 200) : 50;
}

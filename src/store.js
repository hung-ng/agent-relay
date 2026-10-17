import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const now = () => new Date().toISOString();

export class Store {
  constructor(filename = "./data/agent-relay.db") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
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
        claimed_by TEXT
      );

      CREATE INDEX IF NOT EXISTS messages_recipient_status
        ON messages(recipient, status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_status_created
        ON jobs(status, created_at);
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
  }

  close() {
    this.db.close();
  }

  checkReady() {
    this.db.prepare("SELECT 1").get();
    return true;
  }

  registerAgent({ id, hostId, kind = "unknown", capabilities = [], metadata = {} }) {
    const timestamp = now();
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
    `).run(id, hostId, kind, JSON.stringify(capabilities), JSON.stringify(metadata), timestamp, timestamp);
    return this.getAgent(id);
  }

  heartbeat(id) {
    const timestamp = now();
    const result = this.db.prepare(
      "UPDATE agents SET status = 'online', last_seen = ? WHERE id = ?"
    ).run(timestamp, id);
    return result.changes > 0 ? this.getAgent(id) : null;
  }

  getAgent(id) {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? this.#agent(row) : null;
  }

  listAgents() {
    this.markStale();
    return this.db.prepare("SELECT * FROM agents ORDER BY id").all().map((row) => this.#agent(row));
  }

  findAgentForHost(hostId, capability) {
    this.markStale();
    const rows = this.db.prepare(
      "SELECT * FROM agents WHERE host_id = ? AND status = 'online' ORDER BY last_seen DESC"
    ).all(hostId);
    const match = rows.find((row) => {
      const capabilities = JSON.parse(row.capabilities);
      return !capability || capabilities.includes(capability);
    });
    return match ? this.#agent(match) : null;
  }

  agentSupports(agentId, capability) {
    this.markStale();
    const agent = this.getAgent(agentId);
    return Boolean(agent && agent.status === "online" && (!capability || agent.capabilities.includes(capability)));
  }

  markStale(maxAgeMs = 45_000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.prepare(
      "UPDATE agents SET status = 'offline' WHERE status = 'online' AND last_seen < ?"
    ).run(cutoff).changes;
  }

  createMessage({ id, conversationId = null, sender, recipient, type = "message", payload }) {
    const messageId = id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO messages
        (id, conversation_id, sender, recipient, type, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(messageId, conversationId, sender, recipient, type, JSON.stringify(payload), timestamp);
    return this.getMessage(messageId);
  }

  getMessage(id) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? this.#message(row) : null;
  }

  getMessages(recipient, limit = 50) {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE recipient = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(recipient, Math.min(Math.max(Number(limit) || 50, 1), 200));
    return rows.map((row) => this.#message(row));
  }

  getPendingMessages(recipient, limit = 50) {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE recipient = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(recipient, Math.min(Math.max(Number(limit) || 50, 1), 200));
    return rows.map((row) => this.#message(row));
  }

  getPendingWork(agentId, limit = 50) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
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
    return this.#transitionMessage(id, agentId, "delivered");
  }

  acknowledgeMessage(id) {
    return this.#transitionMessage(id, null, "acknowledged");
  }

  acknowledgeMessageBy(id, agentId) {
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
    const jobId = id ?? randomUUID();
    const timestamp = now();
    const boundedAttempts = Math.min(Math.max(Number(maxAttempts) || 3, 1), 10);
    this.db.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, requested_by, target_agent, source_host, target_host, payload, status, attempts, max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    `).run(jobId, kind, requiredCapability, requestedBy, targetAgent, sourceHost, targetHost, JSON.stringify(payload), boundedAttempts, timestamp);
    return this.getJob(jobId);
  }

  getJob(id) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? this.#job(row) : null;
  }

  claimJob(id, agentId) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'running', claimed_by = ?, started_at = ?, attempts = attempts + 1
      WHERE id = ? AND status = 'queued' AND (target_agent IS NULL OR target_agent = ?)
    `).run(agentId, timestamp, id, agentId);
    if (result.changes > 0) return this.getJob(id);
    const existing = this.getJob(id);
    return existing?.status === 'running' && existing.claimed_by === agentId ? existing : null;
  }

  completeJob(id, result) {
    return this.#finishJob(id, "completed", { result });
  }

  completeJobBy(id, result, agentId) {
    return this.#finishJob(id, "completed", { result }, agentId);
  }

  failJob(id, error) {
    return this.#finishJob(id, "failed", { error });
  }

  failJobBy(id, error, agentId) {
    return this.#finishJob(id, "failed", { error }, agentId);
  }

  #finishJob(id, status, values, agentId = null) {
    const existing = this.getJob(id);
    if (!existing || (agentId && existing.claimed_by !== agentId)) return null;
    const timestamp = now();
    if (status === "completed") {
      this.db.prepare(`
        UPDATE jobs SET status = 'completed', result = ?, completed_at = ?
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(values.result ?? {}), timestamp, id);
    } else {
      const terminal = existing.attempts >= existing.max_attempts;
      if (terminal) {
        this.db.prepare(`
          UPDATE jobs SET status = 'failed', error = ?, completed_at = ?
          WHERE id = ? AND status = 'running'
        `).run(String(values.error), timestamp, id);
      } else {
        this.db.prepare(`
          UPDATE jobs SET status = 'queued', error = ?, completed_at = NULL, started_at = NULL, claimed_by = NULL
          WHERE id = ? AND status = 'running'
        `).run(String(values.error), id);
      }
    }
    return this.getJob(id);
  }

  cancelJob(id) {
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
      claimed_by: row.claimed_by
    };
  }
}

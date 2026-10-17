import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { backupDatabase } from "../scripts/backup-db.mjs";
import { checkRelay } from "../scripts/monitor-relay.mjs";

test("backs up SQLite data, checks integrity, and prunes old backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-"));
  const dbPath = path.join(root, "agent-relay.db");
  const backupDir = path.join(root, "backups");
  const store = new Store(dbPath);
  store.registerAgent({ id: "probe@test", hostId: "test", capabilities: ["network.probe"] });
  store.close();

  const first = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-17T12:00:00.000Z") });
  const second = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-17T12:00:01.000Z") });
  const files = await readdir(backupDir);

  assert.equal(first.integrity, "ok");
  assert.equal(second.integrity, "ok");
  assert.deepEqual(files.filter((name) => name.endsWith(".db")).length, 1);
  assert.ok((await stat(second.path)).size > 0);
  await rm(root, { recursive: true, force: true });
});

test("monitor checks relay health and the expected online capability", async () => {
  const responses = {
    "/healthz": { ok: true, service: "agent-relay" },
    "/readyz": { ok: true, service: "agent-relay" },
    "/v1/agents": { agents: [{ id: "probe@test", status: "online", capabilities: ["network.probe"] }] }
  };
  const result = await checkRelay({
    baseUrl: "http://relay",
    expectedAgentId: "probe@test",
    fetchImpl: async (url) => ({ ok: true, status: 200, async json() { return responses[new URL(url).pathname]; } })
  });
  assert.equal(result.ok, true);
  assert.equal(result.agent.id, "probe@test");
});

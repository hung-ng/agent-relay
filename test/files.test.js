import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { writePrivateFile } from "../src/files.js";

test("private file writes replace complete files and leave no temporary files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-private-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "state.json");
  await writeFile(filename, "old", { mode: 0o644 });
  const values = Array.from({ length: 20 }, (_, id) => JSON.stringify({ id, body: "complete".repeat(1000) }));
  await Promise.all(values.map((value) => writePrivateFile(filename, value)));
  assert.ok(values.includes(await readFile(filename, "utf8")));
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ["state.json"]);
});

test("replacing a symlink never overwrites its target", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-private-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const link = path.join(root, "config");
  await writeFile(target, "leave intact");
  await symlink(target, link);
  await writePrivateFile(link, "new config");
  assert.equal(await readFile(target, "utf8"), "leave intact");
  assert.equal(await readFile(link, "utf8"), "new config");
});

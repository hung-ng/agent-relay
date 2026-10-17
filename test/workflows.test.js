import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskPayload, listWorkflows } from "../src/workflows.js";

test("lists the initial Codex task workflows", () => {
  assert.deepEqual(listWorkflows().map(({ name }) => name), ["prompt", "review", "test", "implement"]);
});

test("builds an implement workflow payload with the original request", () => {
  const payload = buildTaskPayload({ workflow: "implement", prompt: "add a health check", cwd: "/tmp/project" });
  assert.equal(payload.workflow, "implement");
  assert.equal(payload.execution_mode, "write");
  assert.equal(payload.cwd, "/tmp/project");
  assert.match(payload.prompt, /Implement this task/);
  assert.match(payload.prompt, /add a health check/);
  assert.match(payload.prompt, /Run relevant tests/);
});

test("marks read-only workflows for unattended Codex execution", () => {
  assert.equal(buildTaskPayload({ workflow: "review", prompt: "inspect the routes" }).execution_mode, "read_only");
  assert.equal(buildTaskPayload({ workflow: "test", prompt: "run the suite" }).execution_mode, "read_only");
});

test("rejects unknown workflows and empty prompts", () => {
  assert.throws(() => buildTaskPayload({ workflow: "deploy", prompt: "ship it" }), /unknown workflow/);
  assert.throws(() => buildTaskPayload({ workflow: "prompt", prompt: "  " }), /non-empty prompt/);
});

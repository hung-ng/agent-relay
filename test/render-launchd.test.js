import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const renderer = fileURLToPath(new URL("../scripts/render-launchd.mjs", import.meta.url));
const templateDirectory = fileURLToPath(new URL("../deploy/launchd/", import.meta.url));
const previousPlist = '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>keep-me</string></dict></plist>\n';

async function fixture(t, projectName = "project") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-relay-launchd-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, projectName);
  await mkdir(root);
  return {
    temporary,
    root,
    output: path.join(temporary, "LaunchAgents", "rendered.plist"),
    env: {
      HOME: temporary,
      PATH: "/usr/bin:/bin",
      AGENT_RELAY_ROOT: root,
      AGENT_RELAY_URL: "https://relay.example.invalid",
      AGENT_ID: "probe@test",
      HOST_ID: "test"
    }
  };
}

function render(context, template = "server", overrides = {}, args) {
  const env = { ...context.env, ...overrides };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  return spawnSync(process.execPath, [renderer, ...(args ?? [path.join(templateDirectory, `${template}.plist.template`), context.output])], {
    cwd: context.root,
    env,
    encoding: "utf8",
    timeout: 5000
  });
}

function succeeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}

function lintPlist(t, filename) {
  const result = spawnSync("plutil", ["-lint", "--", filename], { encoding: "utf8", timeout: 5000 });
  if (result.error?.code === "ENOENT") {
    t.diagnostic("plutil is unavailable; plist lint skipped");
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

async function mode(filename) {
  return (await stat(filename)).mode & 0o777;
}

for (const template of ["server", "worker", "monitor", "backup"]) {
  test(`CLI renders the ${template} template and prepares private directories`, async (t) => {
    const context = await fixture(t);
    succeeded(render(context, template));
    const content = await readFile(context.output, "utf8");
    assert.doesNotMatch(content, /@@[A-Z0-9_]+@@/);
    assert.ok(content.includes(`<string>${process.execPath}</string>`));
    assert.equal(await mode(context.output), 0o600);
    assert.equal(await mode(path.dirname(context.output)), 0o700);
    assert.equal(await mode(path.join(context.root, "data")), 0o700);
    assert.equal(await mode(path.join(context.root, "data", "logs")), 0o700);
    if (template === "worker") assert.ok(content.includes("<string>/usr/bin:/bin</string>"));
    if (template === "monitor") assert.ok(content.includes(`${context.root}/data/agent-relay.token`));
    if (template === "backup") assert.equal(await mode(path.join(context.root, "data", "backups")), 0o700);
    lintPlist(t, context.output);
  });
}

test("CLI prepares the monitor's data log directory when launchd logs use another directory", async (t) => {
  const context = await fixture(t);
  const data = path.join(context.temporary, "private", "state & data");
  const logs = path.join(context.temporary, "private", "launchd logs");
  succeeded(render(context, "monitor", { AGENT_RELAY_DATA: data, AGENT_RELAY_LOG_DIR: logs }));
  for (const directory of [data, logs, path.join(data, "logs"), path.join(context.temporary, "private")]) {
    assert.equal(await mode(directory), 0o700);
  }
  await assert.rejects(stat(path.join(context.root, "data")), { code: "ENOENT" });
  lintPlist(t, context.output);
});

test("CLI replaces template placeholders once and preserves XML and replacement characters in values", async (t) => {
  const context = await fixture(t, "project @@AGENT_RELAY_DATA@@ & <source>");
  const token = `literal @@AGENT_RELAY_LOG_DIR@@ @@AGENT_RELAY_TOKEN@@ @@UNKNOWN@@ $& $' $\x60 <>&\"'\r\n😀`;
  const expected = `literal @@AGENT_RELAY_LOG_DIR@@ @@AGENT_RELAY_TOKEN@@ @@UNKNOWN@@ $&amp; $&apos; $\x60 &lt;&gt;&amp;&quot;&apos;&#13;\n😀`;
  succeeded(render(context, "server", { AGENT_RELAY_TOKEN: token }));
  const content = await readFile(context.output, "utf8");
  assert.ok(content.includes(`<string>${expected}</string>`));
  assert.ok(content.includes("project @@AGENT_RELAY_DATA@@ &amp; &lt;source&gt;/src/cli.js"));
  assert.equal(await mode(path.join(context.root, "data", "logs")), 0o700);
  lintPlist(t, context.output);
});

test("CLI atomically replaces an existing plist with mode 0600", async (t) => {
  const context = await fixture(t);
  await mkdir(path.dirname(context.output));
  await writeFile(context.output, previousPlist, { mode: 0o644 });
  const oldFile = path.join(context.temporary, "previous.plist");
  await link(context.output, oldFile);
  succeeded(render(context, "server", { AGENT_RELAY_TOKEN: "new-token" }));
  assert.equal(await readFile(oldFile, "utf8"), previousPlist);
  assert.equal(await mode(oldFile), 0o644);
  assert.equal(await mode(context.output), 0o600);
  assert.notEqual((await stat(context.output)).ino, (await stat(oldFile)).ino);
  assert.deepEqual(await readdir(path.dirname(context.output)), ["rendered.plist"]);
  lintPlist(t, context.output);
});

test("CLI replaces an output symlink without changing its target", async (t) => {
  const context = await fixture(t);
  const target = path.join(context.temporary, "target.plist");
  await writeFile(target, previousPlist);
  await mkdir(path.dirname(context.output));
  await symlink(target, context.output);
  succeeded(render(context));
  assert.equal(await readFile(target, "utf8"), previousPlist);
  assert.equal((await lstat(context.output)).isSymbolicLink(), false);
  assert.equal(await mode(context.output), 0o600);
  lintPlist(t, context.output);
});

test("CLI rejects missing and unknown placeholders before creating directories", async (t) => {
  const context = await fixture(t);
  const missing = render(context, "worker", { HOST_ID: undefined });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing value for HOST_ID/);
  const template = path.join(context.temporary, "unknown.template");
  await writeFile(template, "@@AGENT_RELAY_DATA@@ @@UNKNOWN@@");
  const unknown = render(context, "server", {}, [template, context.output]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /missing value for UNKNOWN/);
  await assert.rejects(stat(path.join(context.root, "data")), { code: "ENOENT" });
  await assert.rejects(stat(path.dirname(context.output)), { code: "ENOENT" });
});

test("CLI validates inputs before mutations and preserves the installed plist on failure", async (t) => {
  const cases = [
    ["missing root", "server", { AGENT_RELAY_ROOT: undefined }, /missing value for AGENT_RELAY_ROOT/],
    ["relative root", "server", { AGENT_RELAY_ROOT: "relative" }, /AGENT_RELAY_ROOT must be an absolute path/],
    ["relative data", "server", { AGENT_RELAY_DATA: "relative" }, /AGENT_RELAY_DATA must be an absolute path/],
    ["relative logs", "server", { AGENT_RELAY_LOG_DIR: "relative" }, /AGENT_RELAY_LOG_DIR must be an absolute path/],
    ["relative node", "server", { NODE_BIN: "node" }, /NODE_BIN must be an absolute path/],
    ["relative token file", "monitor", { AGENT_RELAY_TOKEN_FILE: "relative.token" }, /AGENT_RELAY_TOKEN_FILE must be an absolute path/],
    ["empty identity", "worker", { AGENT_ID: "" }, /missing value for AGENT_ID/],
    ["nested log path", "worker", { AGENT_ID: "../outside/worker" }, /AGENT_ID must not contain path separators/],
    ["backslash identity", "worker", { AGENT_ID: "nested\\worker" }, /AGENT_ID must not contain path separators/],
    ["invalid XML", "server", { AGENT_RELAY_TOKEN: "secret\u0001value" }, /invalid XML character in AGENT_RELAY_TOKEN/],
    ["invalid URL", "worker", { AGENT_RELAY_URL: "ftp://relay.example.invalid" }, /AGENT_RELAY_URL must be an HTTP or HTTPS URL/],
    ["invalid monitor URL", "monitor", { AGENT_RELAY_MONITOR_URL: "invalid" }, /AGENT_RELAY_MONITOR_URL must be an HTTP or HTTPS URL/],
    ["invalid port", "server", { AGENT_RELAY_PORT: "65536" }, /AGENT_RELAY_PORT must be an integer/],
    ["invalid timeout", "worker", { AGENT_RELAY_TASK_TIMEOUT_MS: "0" }, /AGENT_RELAY_TASK_TIMEOUT_MS must be an integer/],
    ["invalid retention", "backup", { AGENT_RELAY_BACKUP_RETENTION: "1.5" }, /AGENT_RELAY_BACKUP_RETENTION must be an integer/]
  ];
  for (const [name, template, overrides, expected] of cases) {
    await t.test(name, async (t) => {
      const context = await fixture(t);
      await mkdir(path.dirname(context.output));
      await writeFile(context.output, previousPlist, { mode: 0o644 });
      const result = render(context, template, overrides);
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stderr, /secret\u0001value/);
      assert.equal(await readFile(context.output, "utf8"), previousPlist);
      assert.equal(await mode(context.output), 0o644);
      assert.deepEqual(await readdir(path.dirname(context.output)), ["rendered.plist"]);
      assert.deepEqual(await readdir(context.root), []);
    });
  }
});

test("CLI checks directory conflicts before creating any data directory", async (t) => {
  const context = await fixture(t);
  const blocked = path.join(context.temporary, "blocked");
  await writeFile(blocked, "keep");
  const result = render(context, "server", { AGENT_RELAY_LOG_DIR: path.join(blocked, "logs") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a directory|ENOTDIR/);
  assert.equal(await readFile(blocked, "utf8"), "keep");
  assert.deepEqual(await readdir(context.root), []);
  await assert.rejects(stat(path.dirname(context.output)), { code: "ENOENT" });
});

test("CLI validates the working directory and executable before creating runtime directories", async (t) => {
  const context = await fixture(t);
  const missing = path.join(context.temporary, "missing");
  const plainFile = path.join(context.temporary, "not-executable");
  await writeFile(plainFile, "not a directory or executable", { mode: 0o600 });
  const cases = [
    [{ AGENT_RELAY_ROOT: missing }, /ENOENT/],
    [{ AGENT_RELAY_ROOT: plainFile }, /AGENT_RELAY_ROOT must be a directory/],
    [{ NODE_BIN: missing }, /ENOENT/],
    [{ NODE_BIN: context.root }, /NODE_BIN must be a file/],
    [{ NODE_BIN: plainFile }, /EACCES/]
  ];
  for (const [overrides, expected] of cases) {
    const result = render(context, "server", overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.deepEqual(await readdir(context.root), []);
    await assert.rejects(stat(path.dirname(context.output)), { code: "ENOENT" });
  }
});

test("CLI preserves an installed plist when the temporary write fails", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const context = await fixture(t);
  const directory = path.dirname(context.output);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(context.output, previousPlist, { mode: 0o644 });
  let result;
  try {
    await chmod(directory, 0o500);
    result = render(context);
  } finally {
    await chmod(directory, 0o700);
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EACCES/);
  assert.equal(await readFile(context.output, "utf8"), previousPlist);
  assert.equal(await mode(context.output), 0o644);
  assert.deepEqual(await readdir(directory), ["rendered.plist"]);
});

test("CLI leaves an existing output directory intact when replacement fails", async (t) => {
  const context = await fixture(t);
  await mkdir(context.output, { recursive: true });
  const marker = path.join(context.output, "keep");
  await writeFile(marker, "previous output");
  const result = render(context);
  assert.equal(result.status, 1);
  assert.equal(await readFile(marker, "utf8"), "previous output");
  assert.deepEqual(await readdir(path.dirname(context.output)), ["rendered.plist"]);
  assert.deepEqual(await readdir(context.root), []);
});

test("CLI validates only values used by the chosen template", async (t) => {
  const context = await fixture(t);
  succeeded(render(context, "worker", {
    AGENT_RELAY_DATA: "unused-relative-path",
    AGENT_RELAY_LOG_DIR: path.join(context.temporary, "worker-logs"),
    AGENT_RELAY_PORT: "invalid",
    AGENT_RELAY_MONITOR_URL: "invalid",
    AGENT_RELAY_TOKEN_FILE: "unused-relative.token",
    AGENT_RELAY_PATH: "/custom/bin:/usr/bin:/bin"
  }));
  assert.ok((await readFile(context.output, "utf8")).includes("<string>/custom/bin:/usr/bin:/bin</string>"));
  assert.deepEqual(await readdir(context.root), []);
  lintPlist(t, context.output);
});

test("CLI reports usage and missing templates without creating output", async (t) => {
  const context = await fixture(t);
  for (const args of [[], ["template"], ["template", "output", "extra"], ["", context.output], ["template", ""]]) {
    const result = render(context, "server", {}, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: node scripts\/render-launchd.mjs TEMPLATE OUTPUT/);
  }
  const result = render(context, "missing");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(await readdir(context.root), []);
  await assert.rejects(stat(path.dirname(context.output)), { code: "ENOENT" });
});

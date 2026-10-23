import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writePrivateFile } from "../src/files.js";
import { convertPlist, main, parseArgs, updateWorkerToken } from "../scripts/update-worker-token.mjs";

const script = fileURLToPath(new URL("../scripts/update-worker-token.mjs", import.meta.url));

// JSON fixtures exercise the update transaction on hosts without macOS plutil.
function fixtureConvert(bytes) {
  return Buffer.from(JSON.stringify(JSON.parse(bytes.toString("utf8"))));
}

function worker(label, token) {
  return {
    Label: `com.agent-relay.worker.${label}`,
    ProgramArguments: ["/opt/node/bin/node", "/opt/agent-relay/src/cli.js", "worker", "--server", "https://relay.invalid", "--agent", label],
    WorkingDirectory: "/opt/agent-relay",
    EnvironmentVariables: { AGENT_RELAY_TOKEN: token, PATH: "/opt/node/bin:/usr/bin:/bin", AGENT_RELAY_TASK_TIMEOUT_MS: "600000", UNRELATED: token },
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 17,
    StandardOutPath: `/tmp/${label}.log`,
    StandardErrorPath: `/tmp/${label}.error.log`,
    Extra: { list: [false, 3.25, "<>&\"'\r\n😀", { tokenIsUnrelated: token }], empty: "" }
  };
}

async function fixture(t, { oldToken = "fake-old", newToken = "fake-new" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-worker-token-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "plists"));
  const plists = ["one", "two"].map((name) => path.join(root, "plists", `${name}.plist`));
  for (const [index, filename] of plists.entries()) {
    await writeFile(filename, `${JSON.stringify(worker(`test-${index}`, oldToken), null, 2)}\n`, { mode: 0o644 });
    await chmod(filename, 0o644);
  }
  const newTokenFile = path.join(root, "candidate.token");
  const copy = path.join(root, "copy.token");
  await writeFile(newTokenFile, `${newToken}\n`, { mode: 0o600 });
  await writeFile(copy, `${oldToken}\r\n`, { mode: 0o600 });
  return { root, oldToken, newToken, options: { newTokenFile, plists, tokenCopies: [copy] } };
}

async function tree(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      const mode = (await stat(filename)).mode & 0o777;
      result.push({ path: path.relative(root, filename), mode, bytes: entry.isFile() ? await readFile(filename, "hex") : null });
      if (entry.isDirectory()) await visit(filename);
    }
  }
  await visit(root);
  return result;
}

const argsFor = (options) => ["--new-token-file", options.newTokenFile, ...options.plists.flatMap((filename) => ["--plist", filename]), ...options.tokenCopies.flatMap((filename) => ["--token-copy", filename])];

function noSecrets(value, context) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.ok(!text.includes(context.oldToken), "must not expose the existing credential");
  assert.ok(!text.includes(context.newToken), "must not expose the candidate credential");
}

test("argument parsing accepts only file options and an optional apply flag", () => {
  assert.deepEqual(parseArgs(["--plist", "a", "--new-token-file", "b", "--token-copy", "c", "--plist", "d", "--apply"]), {
    newTokenFile: "b", plists: ["a", "d"], tokenCopies: ["c"], apply: true
  });
  for (const args of [[], ["--new-token-file", "a"], ["--plist", "a"], ["--token", "never-echo-this"], ["--new-token-file=a"],
    ["--new-token-file", "a", "--plist"], ["--new-token-file", "a", "--plist", ""],
    ["--new-token-file", "a", "--plist", "b", "--new-token-file", "c"],
    ["--new-token-file", "a", "--plist", "b", "--apply", "--apply"],
    ["--new-token-file", "a", "--plist", "b", "extra"]]) {
    assert.throws(() => parseArgs(args), (error) => !error.message.includes("never-echo-this"));
  }
});

test("default dry-run creates nothing and reports only labels, paths, and counts", async (t) => {
  const context = await fixture(t);
  const before = await tree(context.root);
  const output = [];
  await main(argsFor(context.options), { convert: fixtureConvert, log: (line) => output.push(line), writeFile: () => assert.fail("dry-run must not write") });
  assert.deepEqual(await tree(context.root), before);
  assert.match(output.join("\n"), /Dry-run: 3 of 3 files would change/);
  assert.match(output.join("\n"), /com\.agent-relay\.worker\.test-0/);
  assert.match(output.join("\n"), /Launchd reload is still required/);
  noSecrets(output, context);
  const result = await updateWorkerToken(context.options, { convert: fixtureConvert });
  assert.equal(result.backupPath, null);
  noSecrets(result, context);
});

test("apply changes only credentials and saves private original bytes for every target", async (t) => {
  const context = await fixture(t);
  const paths = [...context.options.plists, ...context.options.tokenCopies];
  const original = await Promise.all(paths.map((filename) => readFile(filename)));
  const result = await updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert });
  assert.equal(result.changed, 3);
  assert.equal(path.dirname(result.backupPath), path.dirname(context.options.plists[0]));
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o700);
  const manifest = JSON.parse(await readFile(path.join(result.backupPath, "manifest.json"), "utf8"));
  assert.equal(manifest.targets.length, paths.length);
  noSecrets(manifest, context);
  for (const [index, filename] of paths.entries()) {
    const entry = manifest.targets[index];
    assert.equal(entry.path, filename);
    assert.equal(entry.mode, index < 2 ? 0o644 : 0o600);
    assert.deepEqual(await readFile(path.join(result.backupPath, entry.backupFile)), original[index]);
    assert.equal((await stat(path.join(result.backupPath, entry.backupFile))).mode & 0o777, 0o600);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    if (index < 2) {
      const expected = JSON.parse(original[index]);
      expected.EnvironmentVariables.AGENT_RELAY_TOKEN = context.newToken;
      assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), expected);
    } else {
      assert.equal(await readFile(filename, "utf8"), `${context.newToken}\n`);
    }
  }
  assert.equal((await stat(path.join(result.backupPath, "manifest.json"))).mode & 0o777, 0o600);
  assert.equal(await readFile(context.options.newTokenFile, "utf8"), `${context.newToken}\n`);
  noSecrets(result, context);
});

test("repeat apply accepts all credentials already equal to the candidate", async (t) => {
  const context = await fixture(t, { oldToken: "x", newToken: "y" });
  const first = await updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert });
  const bytes = await Promise.all([...context.options.plists, ...context.options.tokenCopies].map((filename) => readFile(filename)));
  const second = await updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert });
  assert.equal(second.changed, 0);
  assert.notEqual(first.backupPath, second.backupPath);
  assert.deepEqual(await Promise.all([...context.options.plists, ...context.options.tokenCopies].map((filename) => readFile(filename))), bytes);
  const manifest = JSON.parse(await readFile(path.join(second.backupPath, "manifest.json"), "utf8"));
  for (const [index, entry] of manifest.targets.entries()) assert.deepEqual(await readFile(path.join(second.backupPath, entry.backupFile)), bytes[index]);
});

test("optional copies and a candidate without a final newline are supported", async (t) => {
  const context = await fixture(t);
  await writeFile(context.options.newTokenFile, context.newToken);
  const options = { ...context.options, tokenCopies: [], apply: true };
  const result = await updateWorkerToken(options, { convert: fixtureConvert });
  assert.equal(result.changed, 2);
  assert.equal(await readFile(context.options.tokenCopies[0], "utf8"), `${context.oldToken}\r\n`);
});

test("already-current credentials still receive private permissions without changing their bytes", async (t) => {
  const context = await fixture(t, { oldToken: "fake-same", newToken: "fake-same" });
  const paths = [...context.options.plists, ...context.options.tokenCopies];
  await chmod(paths[2], 0o400);
  const original = await Promise.all(paths.map((filename) => readFile(filename)));
  const result = await updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert });
  assert.equal(result.changed, 3);
  assert.deepEqual(await Promise.all(paths.map((filename) => readFile(filename))), original);
  for (const filename of paths) assert.equal((await stat(filename)).mode & 0o777, 0o600);
});

test("invalid input never creates backups or changes any input bytes or permissions", async (t) => {
  const cases = [
    ["empty candidate", async (c) => writeFile(c.options.newTokenFile, "")],
    ["candidate with multiple lines", async (c) => writeFile(c.options.newTokenFile, "fake-new\nextra\n")],
    ["candidate with CR injection", async (c) => writeFile(c.options.newTokenFile, "fake-new\rInjected: value")],
    ["candidate with NUL", async (c) => writeFile(c.options.newTokenFile, "fake-new\0")],
    ["invalid UTF-8 candidate", async (c) => writeFile(c.options.newTokenFile, Buffer.from([0xff]))],
    ["candidate with a BOM", async (c) => writeFile(c.options.newTokenFile, `\ufeff${c.newToken}\n`)],
    ["public candidate", async (c) => chmod(c.options.newTokenFile, 0o640)],
    ["public token copy", async (c) => chmod(c.options.tokenCopies[0], 0o604)],
    ["missing copy", async (c) => { c.options.tokenCopies.push(path.join(c.root, "missing.token")); }],
    ["copy mismatch", async (c) => writeFile(c.options.tokenCopies[0], "fake-unrelated\n")],
    ["copy with a BOM", async (c) => writeFile(c.options.tokenCopies[0], `\ufeff${c.oldToken}\n`)],
    ["empty copy", async (c) => writeFile(c.options.tokenCopies[0], "\n")],
    ["copy with multiple lines", async (c) => writeFile(c.options.tokenCopies[0], `${c.oldToken}\nother\n`)],
    ["worker mismatch", async (c) => writeFile(c.options.plists[1], JSON.stringify(worker("other", "fake-unrelated")))],
    ["partial prior rotation", async (c) => writeFile(c.options.plists[1], JSON.stringify(worker("other", c.newToken)))],
    ["invalid plist", async (c) => writeFile(c.options.plists[1], "not-json fake-old")],
    ["duplicate worker", async (c) => { c.options.plists.push(c.options.plists[0]); }],
    ["duplicate normalized worker", async (c) => { c.options.plists.push(path.join(path.dirname(c.options.plists[0]), "..", "plists", "one.plist")); }],
    ["duplicate copy", async (c) => { c.options.tokenCopies.push(c.options.tokenCopies[0]); }],
    ["candidate/worker collision", async (c) => { c.options.newTokenFile = c.options.plists[0]; }],
    ["candidate/copy collision", async (c) => { c.options.newTokenFile = c.options.tokenCopies[0]; }],
    ["worker/copy collision", async (c) => { c.options.tokenCopies.push(c.options.plists[0]); }],
    ["hardlinked targets", async (c) => { const filename = path.join(c.root, "hardlink.plist"); await link(c.options.plists[0], filename); c.options.plists.push(filename); }],
    ["hardlinked candidate", async (c) => { const filename = path.join(c.root, "candidate-alias"); await link(c.options.tokenCopies[0], filename); c.options.newTokenFile = filename; }],
    ["candidate directory", async (c) => { c.options.newTokenFile = c.root; }],
    ["worker directory", async (c) => { c.options.plists[1] = path.dirname(c.options.plists[1]); }],
    ["copy directory", async (c) => { c.options.tokenCopies[0] = c.root; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const context = await fixture(t);
      await mutate(context);
      const before = await tree(context.root);
      await assert.rejects(updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert }), (error) => {
        noSecrets(error.message, context);
        return true;
      });
      assert.deepEqual(await tree(context.root), before);
    });
  }
});

test("symlink inputs and aliases through symlinked directories are rejected before writes", async (t) => {
  for (const kind of ["candidate", "worker", "copy", "directory alias"]) {
    await t.test(kind, async (t) => {
      const context = await fixture(t);
      const filename = path.join(context.root, "alias");
      const target = kind === "candidate" ? context.options.newTokenFile : kind === "copy" ? context.options.tokenCopies[0] : kind === "worker" ? context.options.plists[0] : path.dirname(context.options.plists[0]);
      await symlink(target, filename);
      if (kind === "candidate") context.options.newTokenFile = filename;
      if (kind === "copy") context.options.tokenCopies[0] = filename;
      if (kind === "worker") context.options.plists[0] = filename;
      if (kind === "directory alias") context.options.plists.push(path.join(filename, "one.plist"));
      const before = await tree(context.root);
      await assert.rejects(updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert }));
      assert.deepEqual(await tree(context.root), before);
    });
  }
});

test("non-worker plists and missing worker credentials are rejected", async (t) => {
  for (const [name, change] of [
    ["server label", (p) => { p.Label = "com.agent-relay.server"; }],
    ["empty worker suffix", (p) => { p.Label = "com.agent-relay.worker."; }],
    ["server command", (p) => { p.ProgramArguments[2] = "server"; p.ProgramArguments.push("worker"); }],
    ["wrong script", (p) => { p.ProgramArguments[1] = "/tmp/other.js"; }],
    ["missing arguments", (p) => { delete p.ProgramArguments; }],
    ["non-string argument", (p) => { p.ProgramArguments.push(2); }],
    ["credential in argv", (p) => { p.ProgramArguments.push("--token", "fake-argv-token"); }],
    ["credential in an equals option", (p) => { p.ProgramArguments.push("--token=fake-argv-token"); }],
    ["missing environment", (p) => { delete p.EnvironmentVariables; }],
    ["empty token", (p) => { p.EnvironmentVariables.AGENT_RELAY_TOKEN = ""; }],
    ["non-string token", (p) => { p.EnvironmentVariables.AGENT_RELAY_TOKEN = 42; }]
  ]) {
    await t.test(name, async (t) => {
      const context = await fixture(t);
      const plist = worker("invalid", context.oldToken);
      change(plist);
      await writeFile(context.options.plists[0], JSON.stringify(plist));
      const before = await tree(context.root);
      await assert.rejects(updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert }));
      assert.deepEqual(await tree(context.root), before);
    });
  }
});

test("all replacements must serialize and validate before any write", async (t) => {
  for (const corrupt of [false, true]) {
    await t.test(corrupt ? "conversion loses a value" : "late serialization error", async (t) => {
      const context = await fixture(t);
      const before = await tree(context.root);
      const convert = (bytes, format) => {
        const value = JSON.parse(bytes.toString("utf8"));
        if (format === "xml1" && value.Label.endsWith("test-1") && value.EnvironmentVariables.AGENT_RELAY_TOKEN === context.newToken) {
          if (!corrupt) throw new Error(`untrusted conversion error ${context.newToken}`);
          value.ThrottleInterval = 99;
        }
        return fixtureConvert(Buffer.from(JSON.stringify(value)));
      };
      await assert.rejects(updateWorkerToken({ ...context.options, apply: true }, { convert, writeFile: () => assert.fail("must finish validation first") }), (error) => {
        noSecrets(error.message, context);
        return true;
      });
      assert.deepEqual(await tree(context.root), before);
    });
  }
});

test("a failed replacement restores original bytes and modes and retains recovery backups", async (t) => {
  const context = await fixture(t);
  const paths = [...context.options.plists, ...context.options.tokenCopies];
  const original = await Promise.all(paths.map((filename) => readFile(filename)));
  let failed = false;
  const writes = [];
  const writeFile = async (filename, bytes) => {
    writes.push(filename);
    // Fail after rename too, so the currently attempted target needs restoration.
    await writePrivateFile(filename, bytes);
    if (!failed && filename === context.options.plists[1]) {
      failed = true;
      throw new Error(`injected secret-bearing write error ${context.newToken}`);
    }
  };
  await assert.rejects(updateWorkerToken({ ...context.options, apply: true }, { convert: fixtureConvert, writeFile }), (error) => {
    assert.match(error.message, /original files restored/);
    assert.match(error.message, /Recovery backups/);
    noSecrets(error.message, context);
    return true;
  });
  assert.deepEqual(await Promise.all(paths.map((filename) => readFile(filename))), original);
  assert.equal((await stat(paths[0])).mode & 0o777, 0o644);
  assert.equal((await stat(paths[1])).mode & 0o777, 0o644);
  assert.equal(writes.filter((filename) => filename === paths[0]).length, 2);
  assert.equal(writes.filter((filename) => filename === paths[1]).length, 2);
  assert.equal(writes.filter((filename) => filename === paths[2]).length, 0);
  const directories = (await readdir(path.dirname(paths[0]))).filter((name) => name.startsWith(".agent-relay-worker-token-backup-"));
  assert.equal(directories.length, 1);
  const backup = path.join(path.dirname(paths[0]), directories[0]);
  const manifest = JSON.parse(await readFile(path.join(backup, "manifest.json"), "utf8"));
  for (const [index, entry] of manifest.targets.entries()) assert.deepEqual(await readFile(path.join(backup, entry.backupFile)), original[index]);
});

test("backup failure leaves targets intact and keeps the partial recovery directory", async (t) => {
  const context = await fixture(t);
  const paths = [...context.options.plists, ...context.options.tokenCopies];
  const original = await Promise.all(paths.map((filename) => readFile(filename)));
  let calls = 0;
  await assert.rejects(updateWorkerToken({ ...context.options, apply: true }, {
    convert: fixtureConvert,
    writeFile: async (filename, bytes) => {
      if (++calls === 2) throw new Error(context.oldToken);
      assert.ok(!paths.includes(filename));
      await writePrivateFile(filename, bytes);
    }
  }), (error) => {
    assert.match(error.message, /no targets were changed/);
    noSecrets(error.message, context);
    return true;
  });
  assert.deepEqual(await Promise.all(paths.map((filename) => readFile(filename))), original);
  assert.equal((await readdir(path.dirname(paths[0]))).filter((name) => name.startsWith(".agent-relay-worker-token-backup-")).length, 1);
});

test("plutil uses stdin and captured output with no inherited credential environment", () => {
  const secret = "fake-candidate<&";
  const payload = Buffer.from(JSON.stringify({ token: secret }));
  const converted = convertPlist(payload, "xml1", (command, args, options) => {
    assert.equal(command, "/usr/bin/plutil");
    assert.deepEqual(args, ["-convert", "xml1", "-o", "-", "--", "-"]);
    assert.deepEqual(options.input, payload);
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LC_ALL: "C" });
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.ok(!JSON.stringify({ args, env: options.env }).includes(secret));
    return { status: 0, stdout: Buffer.from("converted"), stderr: Buffer.from(secret) };
  });
  assert.equal(converted.toString(), "converted");
  for (const run of [() => ({ status: 1, stdout: payload, stderr: payload }), () => ({ status: null, error: new Error(secret) }), () => { throw new Error(secret); }]) {
    assert.throws(() => convertPlist(payload, "json", run), { message: "Plist conversion failed." });
  }
});

test("CLI help and invalid options never need conversion or create files", async (t) => {
  const context = await fixture(t);
  const before = await tree(context.root);
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Dry-run is the default/);
  const invalid = spawnSync(process.execPath, [script, "--token", "fake-secret-never-print"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes("fake-secret-never-print"));
  assert.deepEqual(await tree(context.root), before);
});

test("real macOS plutil preserves XML and binary plist values through dry-run and apply", { skip: process.platform !== "darwin" }, async (t) => {
  const context = await fixture(t, { newToken: "fake-new<&\"'" });
  const originals = [];
  for (const [index, filename] of context.options.plists.entries()) {
    const json = await readFile(filename);
    const xml = convertPlist(json, "xml1");
    const bytes = index === 0 ? xml : spawnSync("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "--", "-"], { input: xml, env: { PATH: "/usr/bin:/bin" } }).stdout;
    await writeFile(filename, bytes);
    originals.push(bytes);
  }
  const before = await tree(context.root);
  const dry = spawnSync(process.execPath, [script, ...argsFor(context.options)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(dry.status, 0, dry.stderr);
  noSecrets(dry.stdout + dry.stderr, context);
  assert.deepEqual(await tree(context.root), before);
  const applied = spawnSync(process.execPath, [script, ...argsFor(context.options), "--apply"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Applied: 3 of 3 files changed/);
  noSecrets(applied.stdout + applied.stderr, context);
  for (const [index, filename] of context.options.plists.entries()) {
    const expected = JSON.parse(convertPlist(originals[index], "json"));
    expected.EnvironmentVariables.AGENT_RELAY_TOKEN = context.newToken;
    assert.deepEqual(JSON.parse(convertPlist(await readFile(filename), "json")), expected);
  }
  const repeated = await updateWorkerToken({ ...context.options, apply: true });
  assert.equal(repeated.changed, 0);
});

test("real plutil refuses a lossy numeric type conversion without writes", { skip: process.platform !== "darwin" }, async (t) => {
  const context = await fixture(t);
  const xml = convertPlist(await readFile(context.options.plists[0]), "xml1").toString();
  assert.ok(xml.includes("<integer>17</integer>"));
  await writeFile(context.options.plists[0], xml.replace("<integer>17</integer>", "<real>17</real>"));
  const before = await tree(context.root);
  await assert.rejects(updateWorkerToken({ ...context.options, apply: true }), /cannot be preserved/);
  assert.deepEqual(await tree(context.root), before);
});

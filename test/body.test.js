import test from "node:test";
import assert from "node:assert/strict";
import { MAX_JSON_BYTES, readJsonBody } from "../src/body.js";
import { createServer } from "../src/server.js";

function request(chunks, headers = {}) {
  return { headers, async *[Symbol.asyncIterator]() { yield* chunks; } };
}

function nestedObjects(depth) {
  return '{"n":'.repeat(depth) + "null" + "}".repeat(depth);
}

async function httpRequest(app, method, url, text = "") {
  const response = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); }
  };
  const [handler] = app.server.listeners("request");
  await handler({ ...request([Buffer.from(text)]), method, url }, response);
  return response;
}

test("JSON bodies reject invalid UTF-8 instead of changing their contents", async (t) => {
  for (const bytes of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f]]) {
    await t.test(Buffer.from(bytes).toString("hex"), async () => {
      await assert.rejects(readJsonBody(request([
        Buffer.from('{"body":"'), Buffer.from(bytes), Buffer.from('"}')
      ])), (error) => error.status === 400 && /UTF-8/.test(error.message));
    });
  }
});

test("JSON bodies preserve Unicode across every byte boundary", async () => {
  const value = { body: "€😀漢字�", escaped: "\\\"\n" };
  const bytes = Buffer.from(JSON.stringify(value));
  assert.deepEqual(await readJsonBody(request([...bytes].map((byte) => Buffer.from([byte])))), value);
  assert.deepEqual(await readJsonBody(request([bytes]), { maxBytes: bytes.length }), value);
  await assert.rejects(readJsonBody(request([bytes]), { maxBytes: bytes.length - 1 }), { status: 413 });
});

test("JSON bodies count the root and every nested object or array toward 128 levels", async (t) => {
  for (const [name, build] of [
    ["objects", nestedObjects],
    ["arrays", (depth) => '{"n":' + "[".repeat(depth - 1) + "null" + "]".repeat(depth - 1) + "}"],
    ["mixed", (depth) => {
      const openings = Array.from({ length: depth }, (_, index) => index % 2 ? "[" : '{"n":');
      return openings.join("") + "null" + openings.reverse().map((opening) => opening === "[" ? "]" : "}").join("");
    }]
  ]) {
    await t.test(name, async () => {
      const boundary = build(128);
      assert.equal(JSON.stringify(await readJsonBody(request([Buffer.from(boundary)]))), boundary);
      await assert.rejects(readJsonBody(request([Buffer.from(build(129))])), {
        status: 400, message: "request body exceeds 128 levels of nesting"
      });
    });
  }
  for (const leaf of ["{}", "[]"]) {
    const wrap = (depth) => '{"n":'.repeat(depth - 1) + leaf + "}".repeat(depth - 1);
    assert.equal(JSON.stringify(await readJsonBody(request([Buffer.from(wrap(128))]))), wrap(128));
    await assert.rejects(readJsonBody(request([Buffer.from(wrap(129))])), {
      status: 400, message: "request body exceeds 128 levels of nesting"
    });
  }
});

test("JSON bodies reject thousands of levels without recursive validation", async () => {
  const text = nestedObjects(20_000);
  assert.ok(Buffer.byteLength(text) < MAX_JSON_BYTES);
  assert.doesNotThrow(() => JSON.parse(text));
  await assert.rejects(readJsonBody(request([Buffer.from(text)])), {
    status: 400, message: "request body exceeds 128 levels of nesting"
  });
});

test("JSON depth permits broad shallow data and ignores containers written inside strings", async () => {
  const value = {
    items: Array.from({ length: 20_000 }, () => ({ item: [] })),
    ["[{}]".repeat(200)]: "[{}]".repeat(10_000) + '\\"\n😀'
  };
  const bytes = Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length < MAX_JSON_BYTES);
  assert.deepEqual(await readJsonBody(request([bytes])), value);
});

test("JSON bodies preserve empty-body, object-root, BOM and fixed syntax errors", async () => {
  assert.deepEqual(await readJsonBody(request([])), {});
  for (const text of ["null", "[]", '"private input"', "123", "true"]) {
    await assert.rejects(readJsonBody(request([Buffer.from(text)])), {
      status: 400, message: "request body must be a JSON object"
    });
  }
  for (const text of [" ", '{"secret":"private input",}', '\ufeff{"ok":true}']) {
    const chunks = [...Buffer.from(text)].map((byte) => Buffer.from([byte]));
    await assert.rejects(readJsonBody(request(chunks)), {
      status: 400, message: "request body must be valid JSON"
    });
  }
  assert.deepEqual(await readJsonBody(request([Buffer.from('{"body":"\ufeff"}')])), { body: "\ufeff" });
});

test("JSON bodies retain the exact 1 MiB limit for declared and streamed bytes", async () => {
  const text = '{"body":"' + "x".repeat(MAX_JSON_BYTES - 11) + '"}';
  const bytes = Buffer.from(text);
  assert.equal(bytes.length, MAX_JSON_BYTES);
  const value = await readJsonBody(request([bytes.subarray(0, 100), bytes.subarray(100)], { "content-length": String(bytes.length) }));
  assert.equal(value.body.length, MAX_JSON_BYTES - 11);
  await assert.rejects(readJsonBody(request([bytes, Buffer.from(" ")])), {
    status: 413, message: "request body exceeds 1048576 bytes"
  });
  const declared = request([], { "content-length": String(MAX_JSON_BYTES + 1) });
  declared[Symbol.asyncIterator] = async function* () { assert.fail("oversized declared bodies must not be read"); };
  await assert.rejects(readJsonBody(declared), {
    status: 413, message: "request body exceeds 1048576 bytes"
  });
});

test("HTTP rejects excessive metadata depth before registration and keeps agent reads working", async (t) => {
  const app = createServer({ dbPath: ":memory:", token: "", previousToken: "" });
  t.after(() => app.close());
  const original = app.store.registerAgent({ id: "existing", hostId: "original", metadata: { keep: true } });
  const register = t.mock.method(app.store, "registerAgent");
  for (const metadataDepth of [128, 5845]) {
    const text = '{"id":"existing","host_id":"changed","metadata":' + nestedObjects(metadataDepth) + "}";
    const response = await httpRequest(app, "POST", "/v1/agents/register", text);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "request body exceeds 128 levels of nesting" });
    assert.equal(register.mock.callCount(), 0);
    assert.deepEqual(app.store.getAgent("existing"), original);
  }
  const boundary = '{"id":"boundary","host_id":"host","metadata":' + nestedObjects(127) + "}";
  const registered = await httpRequest(app, "POST", "/v1/agents/register", boundary);
  assert.equal(registered.status, 200);
  assert.equal(register.mock.callCount(), 1);
  const listed = await httpRequest(app, "GET", "/v1/agents");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.agents, [registered.body.agent, original]);
});

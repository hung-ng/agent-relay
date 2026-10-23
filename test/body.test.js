import test from "node:test";
import assert from "node:assert/strict";
import { readJsonBody } from "../src/body.js";

function request(chunks) {
  return { headers: {}, async *[Symbol.asyncIterator]() { yield* chunks; } };
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

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";

export async function writePrivateFile(filename, content, { install = rename } = {}) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await install(temporary, filename);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return javascriptFiles(filename);
      return entry.isFile() && /\.(?:c|m)?js$/.test(entry.name) ? [filename] : [];
    });
}

const files = ["src", "scripts", "test"].flatMap((directory) => javascriptFiles(path.join(root, directory)));
for (const filename of files) {
  const result = spawnSync(process.execPath, ["--check", filename], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);

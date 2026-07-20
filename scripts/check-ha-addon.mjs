import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = resolve(root, "artifacts", "home-assistant");
const outputApp = resolve(outputRoot, "dienstenlezer");
const required = [
  "config.yaml",
  "Dockerfile",
  "DOCS.md",
  "README.md",
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "src",
  "src-tauri",
];

for (const path of required) {
  await access(resolve(outputApp, path));
}

const config = await readFile(resolve(outputApp, "config.yaml"), "utf8");
for (const value of ["__VERSION__", "__IMAGE_LINE__"]) {
  if (config.includes(value)) throw new Error(`Niet vervangen placeholder: ${value}`);
}
for (const value of ["aarch64", "amd64", '"8080/tcp": 8080', "/api/health"]) {
  if (!config.includes(value)) throw new Error(`Ontbrekende add-oninstelling: ${value}`);
}

for (const forbidden of ["server-data", "node_modules", "dist", "target"]) {
  try {
    await access(resolve(outputApp, forbidden));
    throw new Error(`Onbedoelde map in add-onpakket: ${forbidden}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function sizeOf(path) {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  const children = await readdir(path);
  return children.reduce(async (total, child) => (await total) + await sizeOf(resolve(path, child)), Promise.resolve(0));
}

const bytes = await sizeOf(outputRoot);
console.log(`Home Assistant-pakket is compleet (${(bytes / 1024 / 1024).toFixed(1)} MB).`);

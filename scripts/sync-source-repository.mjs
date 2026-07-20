import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultRepository = resolve(root, "artifacts", "github", "DienstenLezer");
const repository = resolve(process.env.DIENSTENLEZER_SOURCE_REPOSITORY || defaultRepository);

const repositoryPath = relative(root, repository);
if (repositoryPath.startsWith("..") || isAbsolute(repositoryPath)) {
  throw new Error("De bronrepository moet binnen de DienstenLezer-werkmap staan.");
}
await access(resolve(repository, ".git"));

for (const entry of await readdir(repository, { withFileTypes: true })) {
  if (entry.name === ".git") continue;
  await rm(resolve(repository, entry.name), { recursive: true, force: true });
}

const files = [
  ".dockerignore",
  ".gitignore",
  "build-exe.bat",
  "compose.yaml",
  "Dockerfile",
  "index.html",
  "package-lock.json",
  "package.json",
  "README.md",
  "start-app.bat",
  "start-server.bat",
  "stop-server.bat",
  "tsconfig.json",
  "vite.config.ts",
];

for (const file of files) {
  await cp(resolve(root, file), resolve(repository, file));
}

const excluded = [
  "deploy/home-assistant/published-repository",
  "src-tauri/target",
];
for (const directory of [".github", "deploy", "public", "scripts", "src", "src-tauri"]) {
  const destination = resolve(repository, directory);
  await mkdir(destination, { recursive: true });
  await cp(resolve(root, directory), destination, {
    recursive: true,
    filter: (source) => {
      const path = relative(root, source).replaceAll("\\", "/");
      return !excluded.some((item) => path === item || path.startsWith(`${item}/`));
    },
  });
}

console.log(`Opgeschoonde broncode gesynchroniseerd naar ${repository}.`);
console.log("Lokale pdf's, serverdata, caches, builds en dependencies zijn niet meegenomen.");

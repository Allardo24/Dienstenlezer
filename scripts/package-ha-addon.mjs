import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = resolve(root, "artifacts", "home-assistant");
const outputApp = resolve(outputRoot, "dienstenlezer");
const templateRoot = resolve(root, "deploy", "home-assistant");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const image = process.env.HA_ADDON_IMAGE?.trim();

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputApp, { recursive: true });

for (const file of [
  "Dockerfile",
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
]) {
  await cp(resolve(root, file), resolve(outputApp, file));
}

for (const directory of ["public", "src", "src-tauri"]) {
  await cp(resolve(root, directory), resolve(outputApp, directory), {
    recursive: true,
    filter: (source) => {
      const path = relative(root, source).replaceAll("\\", "/");
      return ![
        "src-tauri/target",
        "src-tauri/gen",
        "src-tauri/icons",
      ].some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
    },
  });
}

for (const file of ["DOCS.md", "README.md", "CHANGELOG.md"]) {
  await cp(resolve(templateRoot, "addon", file), resolve(outputApp, file));
}

const configTemplate = await readFile(
  resolve(templateRoot, "addon", "config.yaml.template"),
  "utf8",
);
const config = configTemplate
  .replace("__VERSION__", packageJson.version)
  .replace("__IMAGE_LINE__", image ? `image: "${image}"` : "# Lokale proefbouw: geen vooraf gebouwd image.");
await writeFile(resolve(outputApp, "config.yaml"), config, "utf8");
await cp(
  resolve(templateRoot, "repository.yaml.template"),
  resolve(outputRoot, "repository.yaml"),
);

const archive = resolve(root, "artifacts", "dienstenlezer-home-assistant.tar.gz");
await rm(archive, { force: true });
const tar = spawnSync("tar", ["-czf", archive, "-C", outputRoot, "."], {
  encoding: "utf8",
});
if (tar.status !== 0) {
  throw new Error(`Kon installatiearchief niet maken: ${tar.stderr || tar.stdout}`);
}

console.log(`Home Assistant-pakket gemaakt: ${outputRoot}`);
console.log(`Installatiearchief gemaakt: ${archive}`);
console.log(image ? `Vooraf gebouwd image: ${image}:${packageJson.version}` : "Modus: lokaal bouwen op Home Assistant");

import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repository = resolve(
  process.env.HA_REPOSITORY_DIR || resolve(root, "deploy", "home-assistant", "published-repository"),
);
const appDirectory = resolve(repository, "dienstenlezer");
const templateRoot = resolve(root, "deploy", "home-assistant");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const image = process.env.HA_ADDON_IMAGE?.trim() || "ghcr.io/allardo24/dienstenlezer";

await access(resolve(repository, ".git"));
await mkdir(appDirectory, { recursive: true });

const configTemplate = await readFile(
  resolve(templateRoot, "addon", "config.yaml.template"),
  "utf8",
);
const config = configTemplate
  .replace("__VERSION__", packageJson.version)
  .replace("__IMAGE_LINE__", `image: "${image}"`);
await writeFile(resolve(appDirectory, "config.yaml"), config, "utf8");

for (const file of ["DOCS.md", "README.md", "CHANGELOG.md"]) {
  await cp(resolve(templateRoot, "addon", file), resolve(appDirectory, file));
}

await writeFile(
  resolve(repository, "repository.yaml"),
  [
    "name: DienstenLezer",
    'url: "https://github.com/Allardo24/Dienstenlezer-HA"',
    "maintainer: Allardo24",
    "",
  ].join("\n"),
  "utf8",
);

await writeFile(
  resolve(repository, "README.md"),
  [
    "# DienstenLezer voor Home Assistant",
    "",
    "Openbare Home Assistant-updatecatalogus voor DienstenLezer.",
    "",
    "Deze repository bevat alleen appmetadata en documentatie. De broncode, pdf-bank en Qbuzz-cache staan hier niet in.",
    "",
    "## Toevoegen aan Home Assistant",
    "",
    "Voeg deze repository toe in **Instellingen > Apps > Appwinkel > Repositories**:",
    "",
    "```text",
    "https://github.com/Allardo24/Dienstenlezer-HA",
    "```",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Home Assistant-repository bijgewerkt naar versie ${packageJson.version}.`);
console.log(`Containerimage: ${image}:${packageJson.version}`);

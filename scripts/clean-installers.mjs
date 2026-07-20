import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const installerDirectory = resolve("src-tauri", "target", "release", "bundle", "nsis");

try {
  const files = await readdir(installerDirectory);
  await Promise.all(
    files
      .filter((file) => /^DienstenLezer_.*_x64-setup\.exe$/i.test(file))
      .map((file) => rm(resolve(installerDirectory, file))),
  );
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

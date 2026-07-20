import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const cargoCommand = isWindows ? "cargo.exe" : "cargo";
const children = [
  spawn(npmCommand, ["run", "web:dev"], { stdio: "inherit", shell: isWindows }),
  spawn(cargoCommand, ["run", "--manifest-path", "src-tauri/Cargo.toml", "--no-default-features", "--features", "server", "--bin", "dienstenlezer-server"], { stdio: "inherit" }),
];

let closing = false;

function stop(exitCode = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 250);
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!closing && code && code !== 0) stop(code);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

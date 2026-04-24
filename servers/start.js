// Launcher: auto-installs node_modules if missing, then starts server.js
import { existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(__dirname, "node_modules", "googleapis"))) {
  process.stderr.write("[google-chat] Installing dependencies (first run)...\n");
  execSync("npm install --omit=dev", { cwd: __dirname, stdio: ["ignore", "ignore", "inherit"] });
  process.stderr.write("[google-chat] Dependencies installed.\n");
}

await import("./server.js");

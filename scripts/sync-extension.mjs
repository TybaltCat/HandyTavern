import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const extensionDir = path.join(rootDir, "sillytavern-extension", "tavernplug-handy");

const filesToSync = ["manifest.json", "index.js", "style.css"];

if (!fs.existsSync(extensionDir)) {
  fs.mkdirSync(extensionDir, { recursive: true });
}

for (const fileName of filesToSync) {
  const sourcePath = path.join(rootDir, fileName);
  const destinationPath = path.join(extensionDir, fileName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing source file: ${sourcePath}`);
  }
  fs.copyFileSync(sourcePath, destinationPath);
  console.log(`[sync] ${fileName}`);
}

console.log(`[sync] completed -> ${extensionDir}`);

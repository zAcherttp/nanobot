import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export let pkgVersion = "0.0.0-fallback";
export let pkgName = "miniclaw";
export let pkgDescription = "Next generation core of nanobot";

try {
  const pkgPath = resolve(__dirname, "../../package.json");
  const pkgData = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (pkgData.version) {
    pkgVersion = pkgData.version;
  }
  if (pkgData.name) {
    pkgName = pkgData.name;
  }
  if (pkgData.description) {
    pkgDescription = pkgData.description;
  }
} catch (e) {
  // Fallback remains
}

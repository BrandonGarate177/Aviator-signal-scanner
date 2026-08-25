/**
 * Minimal .env loader. Node can do this with --env-file, but reading it here
 * keeps `npx tsx src/cli.ts` working with no extra flags.
 * Real environment variables always win over the file.
 */
import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

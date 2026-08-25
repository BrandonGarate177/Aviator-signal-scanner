/**
 * merge-queue-census — one command.
 *
 * Enumerates organizations demonstrably running a merge queue in public on
 * GitHub, ranked by observed queue throughput and segmented by vendor.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCensus, stats } from "./census.js";
import { classifyOrgs } from "./classify.js";
import { loadEnv } from "./env.js";
import { hasToken } from "./gh.js";
import { renderTerminal } from "./report/terminal.js";
import { renderHtml } from "./report/html.js";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1] as string;
  return fallback;
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const log = (s: string) => process.stderr.write(`${s}\n`);

async function main(): Promise<void> {
  loadEnv();

  const outDir = flag("out", "./out");
  const pagesPerShard = Number(flag("pages", "3"));
  const botPages = Number(flag("bot-pages", "3"));
  const maxOrgs = Number(flag("max-orgs", "200"));
  const sinceDays = Number(flag("since-days", "60"));
  const noClassify = process.argv.includes("--no-classify");

  if (!hasToken()) {
    log(
      "warning: no GITHUB_TOKEN and no gh CLI login found. Unauthenticated\n" +
        "         runs hit a 60 req/hour limit and will not complete.\n",
    );
  }

  log("merge-queue-census");
  log("══════════════════════════════════════════════════════\n");

  const started = Date.now();
  const result = await runCensus({
    pagesPerShard,
    botPages,
    since: isoDaysAgo(sinceDays),
    maxOrgs,
    log,
  });

  if (noClassify) {
    log("\nbuyer classification: skipped (--no-classify)");
  } else {
    log("\nclassifying entities (company vs foundation vs community)...");
    const c = await classifyOrgs(result.orgs, log);
    result.coverage.classification = {
      ran: !c.skipped,
      classified: c.classified,
      fromCache: c.fromCache,
      failed: c.failed,
      reason: c.reason ?? null,
    };
  }

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "census.json");
  const htmlPath = join(outDir, "census.html");
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  writeFileSync(htmlPath, renderHtml(result));

  process.stdout.write(renderTerminal(result));

  const secs = Math.round((Date.now() - started) / 1000);
  log(
    `\nrequests: ${stats.requests}  cache hits: ${stats.cacheHits}  errors: ${stats.errors}  (${secs}s)`,
  );
  log(`wrote ${jsonPath}`);
  log(`wrote ${htmlPath}`);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

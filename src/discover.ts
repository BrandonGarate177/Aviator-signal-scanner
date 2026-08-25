/**
 * Stage 1 — Discovery.
 *
 * Find repositories that demonstrably run a merge queue, by reading
 * configuration rather than inferring from activity volume. Two sources:
 *
 *   1. GitHub code search for the `merge_group:` workflow trigger, which is
 *      how a repo opts into GitHub's native merge queue.
 *   2. The merged-PR trail left by competitor merge bots.
 *
 * GitHub caps any single search at 1,000 retrievable results, so the code
 * search is sharded by file size to widen the window past that ceiling.
 */
import { gh } from "./gh.js";
import type { Vendor } from "./types.js";

export interface Discovered {
  nameWithOwner: string;
  owner: string;
  vendors: Set<Vendor>;
  vendorBotPRs: number;
}

interface CodeSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{ repository: { full_name: string; owner: { login: string } } }>;
}

interface IssueSearchResponse {
  total_count: number;
  items: Array<{ repository_url: string }>;
}

/** File-size shards let us reach past the 1,000-result cap on one query. */
const SIZE_SHARDS = ["<800", "800..2000", "2000..6000", ">6000"];

const BOT_VENDORS: Array<{ bot: string; vendor: Vendor }> = [
  { bot: "app/mergify", vendor: "mergify" },
  { bot: "app/aviator-app", vendor: "aviator" },
  { bot: "app/trunk-io", vendor: "trunk" },
  { bot: "app/graphite-app", vendor: "graphite" },
  { bot: "app/kodiakhq", vendor: "kodiak" },
];

function add(
  map: Map<string, Discovered>,
  nameWithOwner: string,
  vendor: Vendor,
  botPRs = 0,
): void {
  const owner = nameWithOwner.split("/")[0];
  if (!owner) return;
  const existing = map.get(nameWithOwner);
  if (existing) {
    existing.vendors.add(vendor);
    existing.vendorBotPRs += botPRs;
    return;
  }
  map.set(nameWithOwner, {
    nameWithOwner,
    owner,
    vendors: new Set([vendor]),
    vendorBotPRs: botPRs,
  });
}

/** Repos opting into GitHub's native merge queue via the merge_group trigger. */
async function discoverNative(
  map: Map<string, Discovered>,
  pagesPerShard: number,
  log: (s: string) => void,
): Promise<number> {
  let totalReported = 0;

  for (const shard of SIZE_SHARDS) {
    const q = encodeURIComponent(
      `"merge_group" path:.github/workflows size:${shard}`,
    );
    for (let page = 1; page <= pagesPerShard; page++) {
      const res = await gh<CodeSearchResponse>(
        `/search/code?q=${q}&per_page=100&page=${page}`,
        { lane: "code_search" },
      );
      if (!res || !res.items?.length) break;
      if (page === 1) totalReported += res.total_count;

      for (const item of res.items) {
        add(map, item.repository.full_name, "github_native");
      }
      log(
        `  native size:${shard} page ${page} — ${res.items.length} files, ${map.size} repos so far`,
      );
      if (res.items.length < 100) break;
    }
  }
  return totalReported;
}

/** Repos where a competitor's merge bot has actually merged pull requests. */
async function discoverVendorBots(
  map: Map<string, Discovered>,
  since: string,
  pages: number,
  log: (s: string) => void,
): Promise<void> {
  for (const { bot, vendor } of BOT_VENDORS) {
    let found = 0;
    for (let page = 1; page <= pages; page++) {
      const q = encodeURIComponent(
        `is:pr is:merged author:${bot} merged:>=${since}`,
      );
      const res = await gh<IssueSearchResponse>(
        `/search/issues?q=${q}&per_page=100&page=${page}`,
        { lane: "search" },
      );
      if (!res || !res.items?.length) break;

      for (const item of res.items) {
        const full = item.repository_url.replace(
          "https://api.github.com/repos/",
          "",
        );
        add(map, full, vendor, 1);
        found++;
      }
      if (res.items.length < 100) break;
    }
    log(`  ${vendor}: ${found} merged PRs observed`);
  }
}

export interface DiscoverOptions {
  /** Pages (100 each) per code-search size shard. */
  pagesPerShard: number;
  /** Pages of merged PRs per competitor bot. */
  botPages: number;
  /** ISO date floor for competitor bot activity. */
  since: string;
  log: (s: string) => void;
}

export async function discover(opts: DiscoverOptions): Promise<{
  repos: Discovered[];
  nativeTotalReported: number;
}> {
  const map = new Map<string, Discovered>();

  opts.log("discovering native merge-queue repos (code search)...");
  const nativeTotalReported = await discoverNative(
    map,
    opts.pagesPerShard,
    opts.log,
  );

  opts.log("discovering competitor merge-bot repos (PR search)...");
  await discoverVendorBots(map, opts.since, opts.botPages, opts.log);

  return { repos: [...map.values()], nativeTotalReported };
}

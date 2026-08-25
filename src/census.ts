/**
 * Stage 3-5 — Measure queue volume, segment by vendor, rank.
 *
 * Ranking is by observed queue throughput (merge_group workflow runs), not by
 * PR volume. Throughput is the thing that makes a queue hurt, and it is the
 * one number here that is measured rather than inferred.
 */
import { gh, stats } from "./gh.js";
import { discover, type Discovered } from "./discover.js";
import { qualifyOrg } from "./qualify.js";
import { knownCustomer, KNOWN_CUSTOMERS } from "./known-customers.js";
import type {
  CensusOrg,
  CensusResult,
  RepoEvidence,
  Segment,
  Vendor,
  VolumeBasis,
} from "./types.js";

interface RepoResponse {
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string | null;
  archived?: boolean;
  fork?: boolean;
  html_url?: string;
}

interface RunsResponse {
  total_count?: number;
  workflow_runs?: Array<{ head_sha?: string }>;
}

/**
 * A team, not a side project. Below this, a merge queue is one person keeping
 * their own repo tidy — real, but not something anyone buys a seat for.
 */
export const MIN_CONTRIBUTORS = 8;

/** A native-queue org above this many runs is running it at real volume. */
export const AT_SCALE_RUNS = 500;

/** Search-API bot logins, for counting a competitor queue's actual merges. */
const VENDOR_BOT_QUERY: Partial<Record<Vendor, string>> = {
  mergify: "app/mergify",
  trunk: "app/trunk-io",
  graphite: "app/graphite-app",
  kodiak: "app/kodiakhq",
  aviator: "app/aviator-app",
};

/**
 * Distinct contributors, capped at one page (100). The cap is deliberate — the
 * question is "is there a team here", not "exactly how many people". Callers
 * render a capped value as "100+" rather than as an exact figure.
 */
export const CONTRIB_CAP = 100;

async function countContributors(nameWithOwner: string): Promise<number> {
  const list = await gh<Array<unknown>>(
    `/repos/${nameWithOwner}/contributors?per_page=100&anon=false`,
    { lane: "core", allow404: true },
  );
  return Array.isArray(list) ? list.length : 0;
}

async function measureRepo(d: Discovered): Promise<RepoEvidence | null> {
  const meta = await gh<RepoResponse>(`/repos/${d.nameWithOwner}`, {
    lane: "core",
    allow404: true,
  });
  if (!meta || meta.archived || meta.fork) return null;

  // One call returns both the total and a sample. The sample is what lets us
  // convert workflow runs into queued batches: a repo with 20 workflow files
  // emits 20 runs per batch, so raw run counts are not comparable across repos.
  const runs = await gh<RunsResponse>(
    `/repos/${d.nameWithOwner}/actions/runs?event=merge_group&per_page=100`,
    { lane: "core", allow404: true },
  );
  const mergeGroupRuns = runs?.total_count ?? 0;

  const sample = runs?.workflow_runs ?? [];
  const distinctShas = new Set(
    sample.map((r) => r.head_sha).filter((x): x is string => Boolean(x)),
  ).size;
  const workflowsPerBatch =
    sample.length > 0 && distinctShas > 0 ? sample.length / distinctShas : 1;
  const queuedBatches = Math.round(mergeGroupRuns / workflowsPerBatch);

  const contributors = await countContributors(d.nameWithOwner);

  let vendorBotPRs: number | undefined;
  let evidenceUrl = `https://github.com/${d.nameWithOwner}/actions?query=event%3Amerge_group`;

  const competitor = [...d.vendors].find(
    (v) => v !== "github_native" && VENDOR_BOT_QUERY[v],
  );
  if (competitor) {
    const bot = VENDOR_BOT_QUERY[competitor] as string;
    const q = encodeURIComponent(
      `repo:${d.nameWithOwner} is:pr is:merged author:${bot}`,
    );
    const res = await gh<{ total_count?: number }>(
      `/search/issues?q=${q}&per_page=1`,
      { lane: "search" },
    );
    vendorBotPRs = res?.total_count ?? d.vendorBotPRs;
    evidenceUrl = `https://github.com/${d.nameWithOwner}/pulls?q=${encodeURIComponent(
      `is:pr is:merged author:${bot}`,
    )}`;
  }

  return {
    nameWithOwner: d.nameWithOwner,
    vendors: [...d.vendors],
    mergeGroupRuns,
    workflowsPerBatch: Number(workflowsPerBatch.toFixed(1)),
    queuedBatches,
    contributors,
    vendorBotPRs,
    description: meta.description ?? null,
    stars: meta.stargazers_count ?? 0,
    pushedAt: meta.pushed_at ?? null,
    url: meta.html_url ?? `https://github.com/${d.nameWithOwner}`,
    evidenceUrl,
  };
}

function segmentOf(vendors: Vendor[], runs: number): Segment {
  if (vendors.includes("aviator")) return "customer";
  const paysCompetitor =
    vendors.includes("mergify") ||
    vendors.includes("trunk") ||
    vendors.includes("graphite") ||
    vendors.includes("kodiak");
  if (paysCompetitor) return "displacement";
  if (vendors.includes("github_native")) {
    return runs >= AT_SCALE_RUNS ? "native_at_scale" : "native";
  }
  return "unqualified";
}

/** Segment multiplier — a paying competitor user outranks a free-tier user. */
const SEGMENT_WEIGHT: Record<Segment, number> = {
  displacement: 1.5,
  native_at_scale: 1.25,
  native: 1.0,
  customer: 0,
  unqualified: 0,
};

export interface CensusOptions {
  pagesPerShard: number;
  botPages: number;
  since: string;
  /** Cap on orgs to measure, highest-signal first. */
  maxOrgs: number;
  log: (s: string) => void;
}

export async function runCensus(opts: CensusOptions): Promise<CensusResult> {
  const { log } = opts;

  const { repos, nativeTotalReported } = await discover({
    pagesPerShard: opts.pagesPerShard,
    botPages: opts.botPages,
    since: opts.since,
    log,
  });

  // Coverage calibration: which publicly named Aviator customers did this
  // method surface at all? Computed over raw discovery, before qualification.
  const discoveredOwners = new Set(repos.map((r) => r.owner.toLowerCase()));
  const knownCustomersFound = KNOWN_CUSTOMERS.filter((c) =>
    discoveredOwners.has(c.org.toLowerCase()),
  ).map((c) => c.company);

  // Group discovered repos by owner.
  const byOwner = new Map<string, Discovered[]>();
  for (const r of repos) {
    const list = byOwner.get(r.owner);
    if (list) list.push(r);
    else byOwner.set(r.owner, [r]);
  }

  log(
    `\ndiscovered ${repos.length} repos across ${byOwner.size} distinct owners`,
  );
  log("qualifying owners (org type, members, resolvable domain)...\n");

  // Qualify owners, most-repos-first so the interesting ones land early.
  const owners = [...byOwner.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  const rejectionReasons: Record<string, number> = {};
  let reposDroppedNoTeam = 0;
  let soloOrgs = 0;
  const qualifiedOrgs: CensusOrg[] = [];
  let rejected = 0;
  let checked = 0;

  for (const [login, ownerRepos] of owners) {
    checked++;
    if (qualifiedOrgs.length >= opts.maxOrgs) break;

    const qualification = await qualifyOrg(login);
    const qualified = qualification.rejections.length === 0;

    if (!qualified) {
      rejected++;
      for (const reason of qualification.rejections) {
        rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
      }
      if (checked % 25 === 0) {
        log(
          `  checked ${checked}/${owners.length} owners — ${qualifiedOrgs.length} qualified, ${rejected} rejected`,
        );
      }
      continue;
    }

    const measured: RepoEvidence[] = [];
    for (const r of ownerRepos) {
      const m = await measureRepo(r);
      if (m) measured.push(m);
    }
    if (measured.length === 0) {
      rejected++;
      rejectionReasons["no_live_repos"] = (rejectionReasons["no_live_repos"] ?? 0) + 1;
      continue;
    }

    // A queue on a repo with no team behind it is a side project. Drop those
    // repos before aggregating, so an org's volume only counts queues that
    // actually serve a team — and an org left with none drops out entirely.
    const evidence = measured.filter((e) => e.contributors >= MIN_CONTRIBUTORS);
    reposDroppedNoTeam += measured.length - evidence.length;
    if (evidence.length === 0) {
      soloOrgs++;
      continue;
    }

    const vendors = [...new Set(evidence.flatMap((e) => e.vendors))];
    const totalBatches = evidence.reduce((s, e) => s + e.queuedBatches, 0);
    const totalBotMerges = evidence.reduce(
      (s, e) => s + (e.vendorBotPRs ?? 0),
      0,
    );
    const maxContributors = Math.max(...evidence.map((e) => e.contributors), 0);

    const customer = knownCustomer(login);
    const segment: Segment = customer
      ? "customer"
      : segmentOf(vendors, totalBatches);

    // Rank on whichever unit actually measures this org's queue.
    const volumeBasis: VolumeBasis =
      segment === "displacement" ? "queue_bot_merges" : "merge_group_runs";
    const observedVolume =
      volumeBasis === "queue_bot_merges" ? totalBotMerges : totalBatches;

    evidence.sort(
      (a, b) =>
        (volumeBasis === "queue_bot_merges"
          ? (b.vendorBotPRs ?? 0) - (a.vendorBotPRs ?? 0)
          : b.queuedBatches - a.queuedBatches) || b.contributors - a.contributors,
    );

    qualifiedOrgs.push({
      login,
      qualification,
      qualified: true,
      repos: evidence,
      vendors,
      segment,
      totalQueuedBatches: totalBatches,
      maxContributors,
      totalVendorBotMerges: totalBotMerges,
      observedVolume,
      volumeBasis,
      knownCustomer: customer
        ? { company: customer.company, source: customer.source }
        : undefined,
      // log scale keeps one enormous repo from flattening the rest of the list
      rank: Math.log10(observedVolume + 10) * SEGMENT_WEIGHT[segment],
      url: `https://github.com/${login}`,
    });

    log(
      `  ✓ ${login} — ${segment}, ${observedVolume} ${volumeBasis}, ${maxContributors} contributors` +
        (customer ? `  [known customer: ${customer.company}]` : ""),
    );
  }

  // "Running a merge queue" means it actually runs. An org that has the config
  // committed but no observed activity is counted, not ranked — including it in
  // the headline list would overstate the claim.
  const active = qualifiedOrgs.filter((o) => o.observedVolume > 0);
  const configuredNotRunning = qualifiedOrgs.length - active.length;

  const running = active;

  running.sort((a, b) => b.rank - a.rank || b.observedVolume - a.observedVolume);

  return {
    generatedAt: new Date().toISOString(),
    toolVersion: "0.1.0",
    coverage: {
      reposDiscovered: repos.length,
      orgsDiscovered: byOwner.size,
      orgsQualified: running.length,
      orgsRejected: rejected,
      configuredNotRunning,
      soloProjects: soloOrgs,
      reposDroppedNoTeam,
      knownCustomersFound,
      knownCustomersTotal: KNOWN_CUSTOMERS.length,
      rejectionReasons,
      searchCapNote:
        `GitHub reports ~${nativeTotalReported.toLocaleString()} matching workflow files but caps any single ` +
        `search at 1,000 retrievable results; this run sharded by file size to widen that window. ` +
        `Private repositories are invisible to this method by construction.`,
    },
    orgs: running,
  };
}

export { stats };

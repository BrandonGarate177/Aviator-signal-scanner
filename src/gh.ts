/**
 * Minimal GitHub REST client: read-through disk cache, rate-limit awareness,
 * retry with backoff. No SDK — the surface we need is four endpoints.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const CACHE_DIR = ".cache";
const UA = "merge-queue-census/0.1 (+github.com/BrandonGarate177)";

/** GitHub's documented per-minute ceilings. Code search is the tight one. */
const BUDGET = {
  code_search: { perMinute: 10, spacingMs: 6_500 },
  search: { perMinute: 30, spacingMs: 2_200 },
  core: { perMinute: 900, spacingMs: 80 },
} as const;

export type Lane = keyof typeof BUDGET;

/** GitHub tokens are opaque but well-shaped; anything else is not a token. */
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

/**
 * Prefer explicit config, then the gh CLI. Absolute paths are tried first
 * because an unrelated npm package named `gh` can shadow the real CLI on PATH,
 * and its output would otherwise be mistaken for a credential.
 */
function resolveToken(): string | undefined {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const candidates = [
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
    "gh",
  ];

  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (TOKEN_RE.test(out)) return out;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const TOKEN = resolveToken();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastCall: Record<Lane, number> = { code_search: 0, search: 0, core: 0 };

function cachePath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(CACHE_DIR, `${hash}.json`);
}

export interface GhOptions {
  lane?: Lane;
  /** Skip the cache read (writes still happen). */
  noCache?: boolean;
  /** Treat 404 as a value rather than an error. */
  allow404?: boolean;
}

export interface GhStats {
  requests: number;
  cacheHits: number;
  errors: number;
}

export const stats: GhStats = { requests: 0, cacheHits: 0, errors: 0 };

/**
 * GET a GitHub API path. Returns parsed JSON, or null for an allowed 404.
 * Every response is cached on disk keyed by path, so re-runs are free and
 * deterministic.
 */
export async function gh<T = unknown>(
  path: string,
  opts: GhOptions = {},
): Promise<T | null> {
  const lane: Lane = opts.lane ?? "core";
  const key = `GET ${path}`;
  const file = cachePath(key);

  if (!opts.noCache && existsSync(file)) {
    stats.cacheHits++;
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      notFound?: boolean;
      body?: T;
    };
    if (raw.notFound) return null;
    return raw.body as T;
  }

  // Space requests within the lane so we never trip a secondary rate limit.
  const since = Date.now() - lastCall[lane];
  const spacing = BUDGET[lane].spacingMs;
  if (since < spacing) await sleep(spacing - since);

  const url = path.startsWith("http") ? path : `${API}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": UA,
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  for (let attempt = 0; attempt <= 3; attempt++) {
    lastCall[lane] = Date.now();
    stats.requests++;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (process.env.DEBUG_GH) {
        process.stderr.write(
          `  [gh] network error ${url}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      if (attempt === 3) {
        stats.errors++;
        return null;
      }
      await sleep(2_000 * (attempt + 1));
      continue;
    }

    if (process.env.DEBUG_GH) {
      process.stderr.write(`  [gh] ${res.status} ${url}\n`);
    }

    if (res.status === 404) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ notFound: true }));
      if (opts.allow404) return null;
      return null;
    }

    // Secondary rate limit or abuse detection — back off and retry.
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
      const waitMs =
        retryAfter || (reset > Date.now() ? Math.min(reset - Date.now(), 65_000) : 0) ||
        15_000 * (attempt + 1);
      if (attempt === 3) {
        stats.errors++;
        return null;
      }
      process.stderr.write(
        `  rate limited on ${lane}; waiting ${Math.round(waitMs / 1000)}s\n`,
      );
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500) {
      if (attempt === 3) {
        stats.errors++;
        return null;
      }
      await sleep(2_000 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      stats.errors++;
      return null;
    }

    const body = (await res.json()) as T;
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ body }));
    return body;
  }

  stats.errors++;
  return null;
}

export function hasToken(): boolean {
  return Boolean(TOKEN);
}

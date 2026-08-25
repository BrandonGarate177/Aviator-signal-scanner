/**
 * Stage 2 — Company qualification.
 *
 * Discovery surfaces whoever runs a merge queue in public, and a large share of
 * that is hobby projects. This stage is what separates "repos using a feature"
 * from "organizations you could sell to", so it is deliberately strict and
 * records *why* it rejected each candidate — the rejection tally is reported.
 */
import { resolve as dnsResolve } from "node:dns/promises";
import { gh } from "./gh.js";
import type { OrgQualification } from "./types.js";

interface OrgResponse {
  type?: string;
  description?: string | null;
  bio?: string | null;
  public_repos?: number;
  followers?: number;
  name?: string | null;
  blog?: string | null;
  created_at?: string | null;
}

/** Thresholds. Deliberately conservative — a false positive costs credibility. */
export const GATES = {
  minPublicRepos: 3,
  /** Prominence floor: an org clears with EITHER followers or public members. */
  minFollowers: 20,
  minPublicMembers: 2,
} as const;

/** Hosts that indicate a code/personal page rather than a company site. */
const NON_COMPANY_HOSTS = [
  "github.io",
  "github.com",
  "gitlab.io",
  "readthedocs.io",
  "medium.com",
  "notion.site",
  "linktr.ee",
  "twitter.com",
  "x.com",
];

/** Vendors themselves and the platform — real orgs, but not sellable leads. */
const EXCLUDED_LOGINS = new Set([
  "github",
  "mergifyio",
  "aviator-co",
  "trunk-io",
  "withgraphite",
  "kodiakhq",
]);

const dnsCache = new Map<string, boolean>();

function normalizeDomain(blog: string | null | undefined): string | null {
  if (!blog) return null;
  const raw = blog.trim();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").toLowerCase();
  if (!host.includes(".")) return null;
  if (NON_COMPANY_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`))) {
    return null;
  }
  return host;
}

async function resolves(host: string): Promise<boolean> {
  const cached = dnsCache.get(host);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const records = await dnsResolve(host, "A").catch(() => dnsResolve(host, "AAAA"));
    ok = Array.isArray(records) && records.length > 0;
  } catch {
    ok = false;
  }
  dnsCache.set(host, ok);
  return ok;
}

async function countPublicMembers(login: string): Promise<number> {
  const members = await gh<Array<unknown>>(
    `/orgs/${login}/members?per_page=100`,
    { lane: "core", allow404: true },
  );
  return Array.isArray(members) ? members.length : 0;
}

export async function qualifyOrg(login: string): Promise<OrgQualification> {
  const rejections: string[] = [];

  const org = await gh<OrgResponse>(`/users/${login}`, {
    lane: "core",
    allow404: true,
  });

  if (!org) {
    return {
      isOrganization: false,
      publicRepos: 0,
      followers: 0,
      publicMembers: 0,
      name: null,
      description: null,
      domain: null,
      createdAt: null,
      rejections: ["account_not_found"],
    };
  }

  const isOrganization = org.type === "Organization";
  const publicRepos = org.public_repos ?? 0;
  const followers = org.followers ?? 0;

  if (!isOrganization) rejections.push("not_an_organization");
  if (EXCLUDED_LOGINS.has(login.toLowerCase())) rejections.push("vendor_or_platform");
  if (publicRepos < GATES.minPublicRepos) rejections.push("too_few_repos");

  // Only spend requests on membership/DNS for candidates still in the running.
  let publicMembers = 0;
  let domain: string | null = null;

  if (isOrganization && !rejections.includes("vendor_or_platform")) {
    publicMembers = await countPublicMembers(login);

    const candidate = normalizeDomain(org.blog);
    if (candidate && (await resolves(candidate))) {
      domain = candidate;
    } else {
      rejections.push("no_resolvable_domain");
    }

    if (followers < GATES.minFollowers && publicMembers < GATES.minPublicMembers) {
      rejections.push("no_org_footprint");
    }
  }

  return {
    isOrganization,
    publicRepos,
    followers,
    publicMembers,
    name: org.name ?? null,
    description: org.description ?? org.bio ?? null,
    domain,
    createdAt: org.created_at ?? null,
    rejections,
  };
}

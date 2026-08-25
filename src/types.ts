/** Which merge-queue vendor an organization is demonstrably running. */
export type Vendor =
  | "github_native"
  | "mergify"
  | "aviator"
  | "trunk"
  | "graphite"
  | "kodiak";

/** Commercial segment, derived from vendor + volume. */
export type Segment =
  | "native_at_scale" // runs GitHub's free queue at volume it wasn't built for
  | "native" // runs GitHub's free queue, lower volume
  | "displacement" // pays a competitor today
  | "customer" // already on Aviator — excluded from outbound
  | "unqualified"; // not a company, or too little evidence

export interface RepoEvidence {
  /** "org/repo" */
  nameWithOwner: string;
  vendors: Vendor[];
  /** Raw workflow runs triggered by the merge_group event. Kept for transparency. */
  mergeGroupRuns: number;
  /**
   * Workflow runs emitted per queued batch, measured from a sample of recent
   * runs. A repo with 20 workflow files emits 20 runs per batch, so raw run
   * counts are not comparable across repos.
   */
  workflowsPerBatch: number;
  /** mergeGroupRuns / workflowsPerBatch — batches actually put through the queue. */
  queuedBatches: number;
  /** Distinct contributors: does a team stand behind this queue, or one person? */
  contributors: number;
  /** Merged PRs authored by a vendor bot, where applicable. */
  vendorBotPRs?: number;
  description: string | null;
  stars: number;
  pushedAt: string | null;
  url: string;
  /** Link a reader can open to confirm the volume number for themselves. */
  evidenceUrl: string;
}

/**
 * What the headline volume number counts. Competitor queues do not emit
 * merge_group events, so the two segments are measured on different units and
 * the unit is always shown rather than silently mixed.
 */
export type VolumeBasis = "merge_group_runs" | "queue_bot_merges";

export interface OrgQualification {
  isOrganization: boolean;
  publicRepos: number;
  followers: number;
  /** Public members. Often 0 because membership defaults to private. */
  publicMembers: number;
  name: string | null;
  /** Org profile description — primary evidence for what this entity is. */
  description: string | null;
  /** Website from the org profile, if it resolves to a real non-code host. */
  domain: string | null;
  createdAt: string | null;
  /** Every reason the org failed qualification. Empty means qualified. */
  rejections: string[];
}

export interface CensusOrg {
  login: string;
  qualification: OrgQualification;
  qualified: boolean;
  repos: RepoEvidence[];
  vendors: Vendor[];
  segment: Segment;
  /** Sum of queued batches across observed repos. */
  totalQueuedBatches: number;
  /** Largest contributor count among this org's queue-running repos. */
  maxContributors: number;
  /** Sum of merged PRs authored by a competitor's queue bot. */
  totalVendorBotMerges: number;
  /** The headline number, and what it counts. */
  observedVolume: number;
  volumeBasis: VolumeBasis;
  /** Set when the org is already named publicly as an Aviator customer. */
  knownCustomer?: { company: string; source: string };
  /** Buyer classification. Absent when the classify pass did not run. */
  classification?: OrgClassification;
  /** Rank score — queue volume weighted by segment. */
  rank: number;
  url: string;
}

export interface CensusResult {
  generatedAt: string;
  toolVersion: string;
  /** Everything the run could not see, stated plainly. */
  coverage: {
    reposDiscovered: number;
    orgsDiscovered: number;
    orgsQualified: number;
    orgsRejected: number;
    /** Qualified orgs whose queue is configured but has no observed activity. */
    configuredNotRunning: number;
    /** Organizations dropped for having no queue on a team-backed repo. */
    soloProjects: number;
    /** Individual repos excluded from volume for having no team behind them. */
    reposDroppedNoTeam: number;
    /**
     * Coverage calibration: how many of Aviator's publicly named customers this
     * method can see at all. A low number is the honest measure of the
     * private-repo blind spot, so it is reported rather than buried.
     */
    knownCustomersFound: string[];
    knownCustomersTotal: number;
    rejectionReasons: Record<string, number>;
    searchCapNote: string;
    /** Set once the buyer-classification pass has been attempted. */
    classification?: {
      ran: boolean;
      classified: number;
      fromCache: number;
      failed: number;
      reason: string | null;
    };
  };
  orgs: CensusOrg[];
}

export const VENDOR_LABEL: Record<Vendor, string> = {
  github_native: "GitHub native merge queue",
  mergify: "Mergify",
  aviator: "Aviator",
  trunk: "Trunk.io",
  graphite: "Graphite",
  kodiak: "Kodiak",
};

/**
 * Is this entity one that buys engineering tooling? Discovery finds everyone
 * running a merge queue; a third of them are foundations, community projects,
 * and public agencies that adopt the practice but never buy seats.
 */
export type EntityType =
  | "company"
  | "vendor_backed_oss"
  | "foundation"
  | "community_oss"
  | "public_sector"
  | "unclear";

export type BuyerClass = "buyer" | "indirect" | "non_buyer";

export interface OrgClassification {
  entityType: EntityType;
  /** Company behind a vendor-backed OSS project, when there is one. */
  commercialBacker: string | null;
  /** Derived in code from entityType — a policy call, not a model judgment. */
  buyerClass: BuyerClass;
  confidence: number;
  /** One line, citing only the facts supplied in the packet. */
  rationale: string;
  model: string;
  promptVersion: string;
}

export const ENTITY_LABEL: Record<EntityType, string> = {
  company: "Company",
  vendor_backed_oss: "Vendor-backed OSS",
  foundation: "Foundation / consortium",
  community_oss: "Community project",
  public_sector: "Public sector",
  unclear: "Unclear",
};

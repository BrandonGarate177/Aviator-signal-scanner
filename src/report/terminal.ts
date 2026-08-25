import type { CensusResult, Segment } from "../types.js";
import { VENDOR_LABEL, ENTITY_LABEL } from "../types.js";

const SEGMENT_LABEL: Record<Segment, string> = {
  native_at_scale: "native@scale",
  native: "native",
  displacement: "displacement",
  customer: "customer",
  unqualified: "unqualified",
};

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

export function renderTerminal(result: CensusResult): string {
  const lines: string[] = [];
  const { coverage } = result;

  const outbound = result.orgs.filter((o) => o.segment !== "customer");
  const customers = result.orgs.filter((o) => o.segment === "customer");

  lines.push("");
  lines.push("MERGE QUEUE CENSUS");
  lines.push("═".repeat(100));
  lines.push(
    `${outbound.length} qualified organizations running a merge queue in public, ranked by observed queue volume.`,
  );
  lines.push(
    "Volume: native = batches put through the queue (workflow runs ÷ workflows per batch);",
  );
  lines.push(
    "        displacement = pull requests merged by that vendor's bot. Contributors capped at 100.",
  );
  lines.push("");
  const SEGMENT_ORDER: Segment[] = ["displacement", "native_at_scale", "native"];
  const header =
    pad("#", 4) +
    pad("ORGANIZATION", 26) +
    "VOLUME".padStart(8) +
    "CONTRIB".padStart(9) +
    "  " +
    pad("RUNNING", 20) +
    pad("ENTITY", 20) +
    "TOP REPO";

  for (const seg of SEGMENT_ORDER) {
    const ORDER: Record<string, number> = { buyer: 0, indirect: 1, non_buyer: 2 };
    const rows = outbound
      .filter((o) => o.segment === seg)
      .sort(
        (a, b) =>
          (a.classification ? ORDER[a.classification.buyerClass]! : 1.5) -
            (b.classification ? ORDER[b.classification.buyerClass]! : 1.5) ||
          b.rank - a.rank,
      );
    if (!rows.length) continue;
    const unit =
      seg === "displacement" ? "merges by vendor bot" : "batches through queue";
    lines.push("");
    lines.push(`${SEGMENT_LABEL[seg].toUpperCase()}  (${rows.length}) — volume = ${unit}`);
    lines.push(header);
    lines.push("─".repeat(100));
    rows.forEach((org, i) => {
      const ordered = [...org.vendors].sort((a, b) =>
        a === "github_native" ? 1 : b === "github_native" ? -1 : 0,
      );
      const top = org.repos[0];
      lines.push(
        pad(String(i + 1), 4) +
          pad(org.qualification.name ?? org.login, 26) +
          String(org.observedVolume).padStart(8) +
          (org.maxContributors >= 100
            ? "100+"
            : String(org.maxContributors)
          ).padStart(9) +
          "  " +
          pad(ordered.map((v) => VENDOR_LABEL[v]).join(" + "), 20) +
          pad(
            org.classification
              ? ENTITY_LABEL[org.classification.entityType]
              : "—",
            20,
          ) +
          (top ? top.nameWithOwner : "—"),
      );
    });
  }

  lines.push("─".repeat(100));
  if (customers.length) {
    lines.push("");
    lines.push(
      `EXCLUDED — already public Aviator customers (${customers.length})`,
    );
    for (const c of customers) {
      lines.push(
        `  ${pad(c.knownCustomer?.company ?? c.login, 22)} ${String(c.observedVolume).padStart(7)} runs   ${c.knownCustomer?.source ?? ""}`,
      );
    }
  }

  lines.push("");
  lines.push("COVERAGE — what this run could and could not see");
  lines.push(
    `  repos discovered: ${coverage.reposDiscovered}   owners discovered: ${coverage.orgsDiscovered}   ` +
      `qualified: ${coverage.orgsQualified}   rejected: ${coverage.orgsRejected}`,
  );
  const reasons = Object.entries(coverage.rejectionReasons).sort(
    (a, b) => b[1] - a[1],
  );
  if (reasons.length) {
    lines.push(
      `  rejected because: ${reasons.map(([k, v]) => `${k}=${v}`).join("  ")}`,
    );
  }
  lines.push(
    `  configured but no observed queue activity (counted, not ranked): ${coverage.configuredNotRunning}`,
  );
  lines.push(
    `  excluded for no team behind the queue (<8 contributors): ${coverage.reposDroppedNoTeam} repos, ${coverage.soloProjects} orgs`,
  );
  if (coverage.classification) {
    lines.push(
      coverage.classification.ran
        ? `  buyer classification: ${coverage.classification.classified + coverage.classification.fromCache} classified, ${coverage.classification.failed} failed`
        : `  buyer classification: NOT RUN — ${coverage.classification.reason ?? "unavailable"}`,
    );
  }
  lines.push(`  ${coverage.searchCapNote}`);
  lines.push("");

  return lines.join("\n");
}

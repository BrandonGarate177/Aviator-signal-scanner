import type { CensusOrg, CensusResult, Segment } from "../types.js";
import { VENDOR_LABEL, ENTITY_LABEL } from "../types.js";

/** Buyers first inside each segment; unclassified sorts with non-buyers. */
const BUYER_ORDER = { buyer: 0, indirect: 1, non_buyer: 2 } as const;
function buyerRank(o: CensusOrg): number {
  return o.classification ? BUYER_ORDER[o.classification.buyerClass] : 1.5;
}

const SEGMENT_META: Record<
  Segment,
  { label: string; blurb: string; tone: string }
> = {
  displacement: {
    label: "Displacement",
    blurb: "Pays a competitor for a merge queue today. Budget and intent already proven.",
    tone: "hot",
  },
  native_at_scale: {
    label: "Native at scale",
    blurb:
      "Runs GitHub's free queue at volume. Native has no parallel queues or affected-target batching.",
    tone: "warm",
  },
  native: {
    label: "Native",
    blurb: "Runs GitHub's free queue at lower volume. Adoption proven, urgency not yet.",
    tone: "cool",
  },
  customer: {
    label: "Existing customer",
    blurb: "Already named publicly as an Aviator customer. Excluded from outbound.",
    tone: "muted",
  },
  unqualified: { label: "Unqualified", blurb: "", tone: "muted" },
};

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

const num = (n: number): string => n.toLocaleString("en-US");

function volumeLabel(org: CensusOrg): string {
  return org.volumeBasis === "queue_bot_merges"
    ? "merges by vendor bot"
    : "batches through the queue";
}

function orgRow(org: CensusOrg, i: number): string {
  const meta = SEGMENT_META[org.segment];
  const ordered = [...org.vendors].sort((a, b) =>
    a === "github_native" ? 1 : b === "github_native" ? -1 : 0,
  );
  const vendors = ordered.map((v) => VENDOR_LABEL[v]).join(" + ");
  const repos = org.repos
    .slice(0, 4)
    .map((r) => {
      const v =
        org.volumeBasis === "queue_bot_merges"
          ? (r.vendorBotPRs ?? 0)
          : r.queuedBatches;
      const detail =
        org.volumeBasis === "queue_bot_merges"
          ? `${r.contributors >= 100 ? "100+" : num(r.contributors)} contributors`
          : `${r.contributors >= 100 ? "100+" : num(r.contributors)} contributors · ${num(r.mergeGroupRuns)} runs ÷ ${r.workflowsPerBatch} workflows`;
      return `<li>
        <a href="${esc(r.evidenceUrl)}">${esc(r.nameWithOwner)}</a>
        <span class="mono dim">${num(v)}</span>
        <span class="detail">${esc(detail)}</span>
      </li>`;
    })
    .join("");

  const domain = org.qualification.domain;
  const cls = org.classification;
  const entity = cls
    ? `<div class="entity ${cls.buyerClass}">${ENTITY_LABEL[cls.entityType]}${
        cls.commercialBacker ? ` · ${esc(cls.commercialBacker)}` : ""
      }</div><div class="why" title="${esc(cls.rationale)}">${esc(cls.rationale)}</div>`
    : `<div class="entity unknown">unclassified</div>`;

  return `<tr class="row${cls && cls.buyerClass === "non_buyer" ? " dimmed" : ""}">
    <td class="rank mono">${i + 1}</td>
    <td>
      <div class="org"><a href="${esc(org.url)}">${esc(org.qualification.name ?? org.login)}</a></div>
      <div class="sub mono">${esc(org.login)}${domain ? ` · <a href="https://${esc(domain)}">${esc(domain)}</a>` : ""}</div>
    </td>
    <td><span class="pill ${meta.tone}">${meta.label}</span>${entity}</td>
    <td class="vol mono">${num(org.observedVolume)}<span class="unit">${volumeLabel(org)}</span></td>
    <td class="mono dim">${esc(vendors)}<span class="unit">${org.maxContributors >= 100 ? "100+" : num(org.maxContributors)} contributors</span></td>
    <td><ul class="repos">${repos}</ul></td>
  </tr>`;
}

export function renderHtml(result: CensusResult): string {
  const { coverage } = result;
  const outbound = result.orgs.filter((o) => o.segment !== "customer");
  const customers = result.orgs.filter((o) => o.segment === "customer");

  const bySegment = (s: Segment): number =>
    outbound.filter((o) => o.segment === s).length;

  const rejections = Object.entries(coverage.rejectionReasons)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, v]) =>
        `<li><span class="mono">${esc(k)}</span><span class="mono dim">${num(v)}</span></li>`,
    )
    .join("");

  const generated = new Date(result.generatedAt).toISOString().replace("T", " ").slice(0, 16);

  return `<title>Merge Queue Census</title>
<style>
  :root {
    --bg: #0d1117; --panel: #151b23; --line: #262d38;
    --fg: #e6edf3; --dim: #8b949e; --faint: #6e7681;
    --hot: #f78166; --warm: #d29922; --cool: #58a6ff; --muted: #6e7681;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 32px 96px; background: var(--bg); color: var(--fg);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  .mono { font-family: var(--mono); font-size: 13px; }
  .dim { color: var(--dim); } .faint { color: var(--faint); }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.02em; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--dim); margin: 48px 0 14px; font-weight: 600; }
  a { color: var(--cool); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { color: var(--faint); font-family: var(--mono); font-size: 12.5px; margin-bottom: 28px; }

  .claim { background: var(--panel); border: 1px solid var(--line);
           border-left: 3px solid var(--cool); border-radius: 6px;
           padding: 18px 22px; margin-bottom: 32px; }
  .claim p { margin: 0 0 10px; }
  .claim p:last-child { margin-bottom: 0; color: var(--dim); font-size: 14px; }

  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
          padding: 12px 18px; min-width: 150px; flex: 1; }
  .stat .n { font-family: var(--mono); font-size: 24px; }
  .stat .l { color: var(--dim); font-size: 12.5px; margin-top: 2px; }

  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; min-width: 940px; }
  th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.07em;
       color: var(--faint); font-weight: 600; padding: 12px 14px; border-bottom: 1px solid var(--line);
       background: var(--panel); }
  td { padding: 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .rank { color: var(--faint); width: 40px; }
  .org { font-weight: 600; }
  .sub { color: var(--faint); font-size: 12px; }
  .vol { font-size: 17px; white-space: nowrap; }
  .unit { display: block; font-size: 11px; color: var(--faint); font-weight: 400; }
  .repos { list-style: none; margin: 0; padding: 0; font-family: var(--mono); font-size: 12px; }
  .repos li { display: grid; grid-template-columns: 1fr auto; gap: 2px 14px; padding: 3px 0; }
  .repos .detail { grid-column: 1 / -1; color: var(--faint); font-size: 11px; }

  .pill { display: inline-block; font-size: 11.5px; padding: 3px 9px; border-radius: 999px;
          border: 1px solid; white-space: nowrap; }
  .pill.hot { color: var(--hot); border-color: #5a2f26; background: #2b1713; }
  .pill.warm { color: var(--warm); border-color: #4a3a12; background: #241d0c; }
  .pill.cool { color: var(--cool); border-color: #1f3d5c; background: #10202f; }
  .pill.muted { color: var(--muted); border-color: var(--line); background: transparent; }

  .legend { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
  .legend li { display: flex; gap: 12px; align-items: baseline; color: var(--dim); font-size: 13.5px; }

  .note { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 18px 22px; }
  .note ul { margin: 8px 0 0; padding-left: 20px; color: var(--dim); font-size: 14px; }
  .note li { margin-bottom: 6px; }
  .reasons { list-style: none; padding: 0; margin: 10px 0 0;
             display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 4px; }
  .reasons li { display: flex; justify-content: space-between; gap: 12px;
                border-bottom: 1px dotted var(--line); padding: 3px 0; }
  .count { color: var(--faint); font-weight: 400; margin-left: 6px; }
  .entity { margin-top: 7px; font-size: 11.5px; font-weight: 600; }
  .entity.buyer { color: #3fb950; }
  .entity.indirect { color: var(--warm); }
  .entity.non_buyer, .entity.unknown { color: var(--faint); font-weight: 400; }
  .why { margin-top: 2px; font-size: 11px; color: var(--faint); max-width: 210px; line-height: 1.4; }
  tr.dimmed td { opacity: 0.55; }
  .segnote { color: var(--dim); font-size: 13.5px; margin: -6px 0 12px; }
  .funnel { display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
            margin: 18px 0 4px; padding: 12px 16px; background: var(--panel);
            border: 1px solid var(--line); border-radius: 6px;
            font-family: var(--mono); font-size: 12.5px; color: var(--dim); }
  .funnel .arrow { color: var(--faint); }
  .funnel .final { color: var(--fg); }
  footer { margin-top: 56px; color: var(--faint); font-size: 12.5px; font-family: var(--mono); }
</style>

<div class="wrap">
  <h1>Merge Queue Census</h1>
  <div class="meta">generated ${esc(generated)} UTC · merge-queue-census v${esc(result.toolVersion)} · every number links to its source</div>

  <div class="claim">
    <p><strong>${num(outbound.length)} organizations running a merge queue in public today</strong>, ranked by
    observed queue volume and segmented by which vendor they run.</p>
    <p>This is a partial view. Private repositories are invisible to this method, so the large
    private-monorepo buyers do not appear here. Every organization that does appear is qualified by
    behavior — it runs a merge queue, in public, and the evidence link proves it.</p>
  </div>

  <div class="stats">
    ${
      coverage.classification?.ran
        ? `<div class="stat"><div class="n">${num(outbound.filter((o) => o.classification?.buyerClass === "buyer").length)}</div><div class="l">classified as companies</div></div>`
        : ""
    }
    <div class="stat"><div class="n">${num(bySegment("displacement"))}</div><div class="l">on a competitor</div></div>
    <div class="stat"><div class="n">${num(bySegment("native_at_scale"))}</div><div class="l">native at scale</div></div>
    <div class="stat"><div class="n">${num(bySegment("native"))}</div><div class="l">native</div></div>
    <div class="stat"><div class="n">${num(customers.length)}</div><div class="l">excluded as customers</div></div>
  </div>

  <div class="funnel">
    <span><strong>${num(coverage.reposDiscovered)}</strong> repos discovered</span>
    <span class="arrow">→</span>
    <span><strong>${num(coverage.orgsDiscovered)}</strong> owners</span>
    <span class="arrow">→</span>
    <span><strong>${num(coverage.orgsRejected)}</strong> rejected by qualification</span>
    <span class="arrow">→</span>
    <span><strong>${num(coverage.configuredNotRunning)}</strong> configured but idle</span>
    <span class="arrow">→</span>
    <span class="final"><strong>${num(coverage.orgsQualified)}</strong> running a queue</span>
  </div>

  <ul class="legend">
    <li><span class="pill hot">Displacement</span> ${esc(SEGMENT_META.displacement.blurb)}</li>
    <li><span class="pill warm">Native at scale</span> ${esc(SEGMENT_META.native_at_scale.blurb)}</li>
    <li><span class="pill cool">Native</span> ${esc(SEGMENT_META.native.blurb)}</li>
  </ul>

  ${(["displacement", "native_at_scale", "native"] as Segment[])
    .map((seg) => {
      const rows = outbound
        .filter((o) => o.segment === seg)
        .sort((a, b) => buyerRank(a) - buyerRank(b) || b.rank - a.rank);
      if (!rows.length) return "";
      const m = SEGMENT_META[seg];
      const unit =
        seg === "displacement"
          ? "merges by that vendor's bot"
          : "merge_group workflow runs";
      return `<h2>${m.label} <span class="count">${num(rows.length)}</span></h2>
      <p class="segnote">${esc(m.blurb)} Volume counts <strong>${unit}</strong>.</p>
      <div class="scroll">
        <table>
          <thead><tr>
            <th>#</th><th>Organization</th><th>Segment</th><th>Observed volume</th>
            <th>Running</th><th>Evidence (top repos)</th>
          </tr></thead>
          <tbody>${rows.map(orgRow).join("")}</tbody>
        </table>
      </div>`;
    })
    .join("")}

  ${
    customers.length
      ? `<h2>Excluded — already Aviator customers</h2>
  <div class="note">
    <p class="dim" style="margin:0">Found by the same method, removed from the list. Pitching a company named on
    Aviator's own homepage would discredit everything above it.</p>
    <ul>${customers
      .map(
        (c) =>
          `<li><strong>${esc(c.knownCustomer?.company ?? c.login)}</strong> —
           <span class="mono">${num(c.observedVolume)}</span> ${esc(volumeLabel(c))} ·
           <a href="${esc(c.knownCustomer?.source ?? c.url)}">source</a></li>`,
      )
      .join("")}</ul>
  </div>`
      : ""
  }

  <h2>Coverage &amp; limitations</h2>
  <div class="note">
    <p style="margin:0 0 4px"><strong>Calibration:</strong> this method surfaced
    <strong>${num(coverage.knownCustomersFound.length)} of ${num(coverage.knownCustomersTotal)}</strong>
    of Aviator's publicly named customers${
      coverage.knownCustomersFound.length
        ? ` (${esc(coverage.knownCustomersFound.join(", "))})`
        : ""
    }.</p>
    <p class="dim" style="margin:0 0 10px; font-size:14px">That ratio is the honest measure of the blind spot:
    companies like DoorDash and Notion run their merge queues on private repositories, where no public
    signal exists. This list is what is visible, not what is out there.</p>
    <ul>
      <li><strong>${num(coverage.reposDiscovered)}</strong> repositories discovered across
          <strong>${num(coverage.orgsDiscovered)}</strong> distinct owners;
          <strong>${num(coverage.orgsQualified)}</strong> qualified as companies,
          <strong>${num(coverage.orgsRejected)}</strong> rejected.</li>
      <li><strong>${num(coverage.configuredNotRunning)}</strong> further qualified organizations have a merge
          queue configured but no observed activity. They are counted here and deliberately left out of the
          ranked list — "configured" is not "running".</li>
      <li><strong>${num(coverage.reposDroppedNoTeam)}</strong> repositories were excluded from volume for
          having fewer than 8 contributors, and <strong>${num(coverage.soloProjects)}</strong> organizations
          dropped out entirely as a result. A queue with no team behind it is a side project, not a lead.</li>
      <li>Volume is <strong>queued batches</strong>, not workflow runs. A repo with 20 workflow files emits
          20 runs per batch, so raw run counts are not comparable between repos; each row shows the divisor
          it used. Contributor counts are capped at 100.</li>
      ${
        coverage.classification?.ran
          ? `<li>Each organization is classified as a company, vendor-backed OSS project, foundation,
             community project, or public-sector body — because adopting a merge queue does not imply
             anyone here buys seats. Non-buyers are kept in the list and dimmed rather than deleted, so
             the classification can be checked. ${num(coverage.classification.classified + coverage.classification.fromCache)}
             classified, ${num(coverage.classification.failed)} failed.</li>`
          : `<li>Buyer classification did not run${
              coverage.classification?.reason
                ? ` — ${esc(coverage.classification.reason)}`
                : ""
            }. Every row is therefore an <em>adopter</em>, not necessarily a buyer.</li>`
      }
      <li>${esc(coverage.searchCapNote)}</li>
      <li>Volume units are not interchangeable: native orgs are counted in <span class="mono">merge_group</span>
          workflow runs; competitor orgs in merges authored by that vendor's bot. Each row states its unit.</li>
      <li>Qualification requires an <em>organization</em> account with a resolvable company domain and a
          minimum public footprint. Personal accounts running a queue on a side project are the dominant
          noise source and are removed here.</li>
    </ul>
    <p class="dim" style="margin:16px 0 0">Rejections by reason:</p>
    <ul class="reasons">${rejections}</ul>
  </div>

  <footer>merge-queue-census · behavioral qualification, not firmographics · github.com/BrandonGarate177</footer>
</div>`;
}

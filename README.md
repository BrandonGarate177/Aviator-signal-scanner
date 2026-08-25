# merge-queue-census

Finds organizations that are **demonstrably running a merge queue in public on
GitHub**, ranks them by observed queue volume, and segments them by which vendor
they run — GitHub's free native queue, or a competitor they already pay.

```bash
npm install
cp .env.example .env      # add GITHUB_TOKEN and (optionally) OPENAI_API_KEY
npx tsx src/cli.ts
open out/census.html
```

Both keys are optional-ish: with no `GITHUB_TOKEN` the tool falls back to your
`gh auth login` session, and with no `OPENAI_API_KEY` it skips the buyer
classification pass and says so on the report rather than pretending.

No seed list. No company names supplied by an operator. The tool discovers the
accounts itself by reading repository configuration.

---

## What it claims — and what it doesn't

> ~200 organizations running a merge queue in public today, ranked by actual
> queue volume, segmented by which vendor they're on.

It is a **partial view**. Private repositories are invisible to this method, so
the large private-monorepo buyers do not appear. What every row does have is
qualification by *behavior* — the organization runs a merge queue, in public,
and the evidence link proves it. That is a list you cannot buy from Clay or
Apollo, because it requires reading repo configs rather than firmographics.

The report states its own coverage gaps on the page, including how many
candidates were rejected and why.

---

## Three hypotheses this killed first

The interesting part of this project is not the tool. It's what the measurements
ruled out. Each was tested against Aviator's own publicly named customers before
being discarded.

### 1. Public PR throughput — inverted

The obvious first idea: high merged-PR volume means merge pain means Aviator
fit. Measured against Aviator's own customer list, it points the wrong way.

| Aviator customer | Public merged PRs, 7d | | Non-customer | Public merged PRs, 7d |
|---|---:|---|---|---:|
| DoorDash *(1,500+ engineers)* | **0** | | Grafana Labs | **1,992** |
| Color Health *(100+ devs)* | **0** | | Vercel | **851** |
| Verkada | **0** | | Airbyte | **462** |
| Notion | 11 | | Sourcegraph | 16 |
| Amplitude | 37 | | Cal.com | 3 |

There's a structural reason, not just a sampling one: GitHub's native merge queue
has been [GA and free on org-owned public repos since July 2023](https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/).
The orgs this signal ranks highest already have a free merge queue for exactly
the repos it can see. **Public OSS volume is an anti-signal for willingness to
pay.**

### 2. AI-agent PR volume — 97% hobby accounts

The next idea looked better on paper: find orgs merging agent-authored code at
volume with nothing verifying it. That is Aviator's 2026 pitch almost verbatim,
and the raw numbers are enormous — 39,117 merged PRs from `copilot-swe-agent`,
19,109 from Devin, 9,539 from `claude[bot]` in under a month.

Sampled 600 of those PRs across 241 distinct owners, then applied company
qualification. **Eight survived**, and not one was a plausible buyer — they were
solo builders and AI micro-startups, plus GitHub itself.

Same disease as hypothesis 1: companies with large private monorepos run their
agents in private repos too.

### 3. Ranking by raw `merge_group` workflow runs — off by up to 20×

The first working version ranked on workflow runs, and it was wrong. A repo with
20 workflow files emits 20 runs per queued batch, so the ranking was partly
sorting by *how many YAML files a repo has*.

| Repo | Raw runs | Workflows per batch | Real batches |
|---|---:|---:|---:|
| `grafana/shared-workflows` | 18,158 | **20.0×** | **908** |
| `metriport/metriport` | 13,792 | 16.7× | 825 |
| `noir-lang/noir` | 21,808 | 6.7× | 2,987 |

Grafana ranked 3rd overall on a **25-star CI utility repo**. The fix costs no
extra API calls: the same request returns the total *and* a sample of recent
runs, and counting distinct `head_sha` in that sample gives the divisor. Every
row shows its own arithmetic.

### 4. Treating any repo as evidence of an engineering org

"Microsoft runs a merge queue" is both obvious and useless — it was one satellite
project out of thousands. The tool now counts contributors per repo and excludes
queues with fewer than 8 behind them, before aggregating. A queue serving three
people is real, but nobody buys seats for it.

### What survived

Read the **configuration**, not the activity. A repo that opts into a merge queue
has said so in a file:

| Fingerprint | Meaning |
|---|---|
| `merge_group:` trigger in `.github/workflows/` | GitHub's free native queue |
| `mergify[bot]` merge trail | Pays Mergify today |
| `aviator-app[bot]` | Already an Aviator customer — excluded |

Adopting *any* merge queue proves the need. Running the *free native* one proves
they'll pay when they outgrow it — native has no parallel queues and no
affected-target batching, which is precisely the differentiator Aviator's
DoorDash case study is built on.

---

## How it works

```
DISCOVER    code search for merge_group triggers, sharded by file size to
            widen past GitHub's 1,000-result cap; plus competitor bot merge trails
   ↓
QUALIFY     organization account · resolvable company domain · public footprint
            (this is load-bearing — hobby projects dominate raw discovery)
   ↓
MEASURE     batches through the queue (runs ÷ workflows per batch), team size,
            or the vendor bot's merge count
   ↓
SEGMENT     displacement · native-at-scale · native · existing customer
   ↓
CLASSIFY    company · vendor-backed OSS · foundation · community · public sector
            (Claude, from facts already verified — see below)
   ↓
REPORT      out/census.html (self-contained) + out/census.json
```

### Why classification is a separate stage

Discovery finds everyone *running* a merge queue. Roughly a third of them are
foundations, community projects, and public agencies — the Finnish National
Agency for Education is a real result, and it is not a lead. Adoption of the
practice does not imply anyone buys seats.

Heuristics get this wrong immediately. Domain suffix is the obvious rule and it
fails on the first case: `gravitee.io` is a company, `opentelemetry.io` is a CNCF
project; `ibm.com` is a company but Qiskit is its open-source arm. So the call is
made by a model (OpenAI, structured output via a JSON schema) from the facts the
scanner already verified — org description, domain, repo names and descriptions,
contributor counts — with hard rules against using outside knowledge or inventing
detail, and a one-line rationale per decision that cites the fact it used.

The buyer/non-buyer policy is applied **in code**, not by the model, so it stays
auditable. Non-buyers are dimmed in the report rather than deleted, so the
classification can be checked instead of trusted. Results are cached by a hash of
(facts + prompt version), so re-runs cost nothing and stay stable.

### Segments

| Segment | Meaning | Angle |
|---|---|---|
| **Displacement** | Pays a competitor today | Budget and belief already proven |
| **Native at scale** | Free native queue, high volume | Running it past what it was built for |
| **Native** | Free native queue, lower volume | Adoption proven, urgency not yet |
| **Existing customer** | Named on aviator.co | Excluded from the list entirely |

Known customers are excluded **before** ranking, not after. A prospect list that
pitches a company named on Aviator's own homepage discredits every row above it.
The exclusion list and its sources are in [`src/known-customers.ts`](src/known-customers.ts).

### Honesty rules the code enforces

- Volume units are never mixed silently. Native orgs count `merge_group` runs;
  competitor orgs count that vendor's bot merges. Each row shows its unit.
- "Configured" is not "running." Orgs with a queue committed but no observed
  activity are counted in coverage and left out of the ranking.
- Every number links to the GitHub page that proves it.
- Rejected candidates are tallied by reason and shown, so the qualification rate
  is visible rather than implied.

---

## Options

| Flag | Default | Effect |
|---|---|---|
| `--pages <n>` | `3` | code-search pages per file-size shard |
| `--bot-pages <n>` | `3` | pages of merged PRs per competitor bot |
| `--max-orgs <n>` | `200` | stop after this many qualified organizations |
| `--since-days <n>` | `60` | lookback window for competitor bot activity |
| `--out <dir>` | `./out` | output directory |
| `--no-classify` | off | skip the LLM classification pass entirely |

Auth: `GITHUB_TOKEN` (or an existing `gh auth login`) and an optional
`OPENAI_API_KEY` (plus `OPENAI_MODEL` to override the default). Both live in
`.env`, which is gitignored — see `.env.example`. Every API response is cached under `.cache/`, so re-runs are
free and deterministic.

---

## Limitations

- **Private repos are invisible.** This is the honest ceiling of the method, and
  the largest buyers live behind it.
- **Public-heavy orgs are over-represented** — OSS foundations and infra vendors
  show up more than product companies of the same size.
- Discovery samples rather than enumerates; GitHub caps any single search at
  1,000 retrievable results and the shard strategy widens that window without
  removing the cap.
- Competitor coverage is effectively Mergify-only: `trunk-io`, `graphite-app`
  and `kodiakhq` bots show no public merge activity in the sampled window.

## What's next

The natural extension is not more scanning. It's the two systems this can't
reach: **free-tier product-usage signal** (which orgs cross the Verify metering
cliff), and a **competitive teardown** against Graphite/Cursor, Trunk, Mergify
and GitHub native. Both were scoped and deliberately left out of v0.

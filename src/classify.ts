/**
 * Stage 6 — Buyer classification.
 *
 * Discovery finds everyone running a merge queue. Roughly a third of them are
 * foundations, community projects, and public agencies: they adopt the practice
 * but never buy seats. Separating those from commercial entities is a judgment
 * call that heuristics get wrong — domain suffix alone fails immediately
 * (gravitee.io is a company, opentelemetry.io is not; ibm.com is a company but
 * Qiskit is its open-source arm), so it is done with a model, from facts the
 * scanner already verified.
 *
 * Degrades cleanly: with no API key the pass is skipped, orgs stay unclassified,
 * and the rest of the report is unaffected.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  BuyerClass,
  CensusOrg,
  EntityType,
  OrgClassification,
} from "./types.js";

export const PROMPT_VERSION = "classify-v1";

/**
 * Overridable because model availability differs per account. If the configured
 * model is rejected, the run prints the models this key can actually reach
 * rather than failing with an opaque 404.
 */
export const CLASSIFY_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5";

const CACHE_DIR = join(".cache", "classify");
/** Orgs per request. Small enough that one bad packet can't skew the batch. */
const BATCH_SIZE = 12;

const ItemSchema = z.object({
  login: z.string(),
  entityType: z.enum([
    "company",
    "vendor_backed_oss",
    "foundation",
    "community_oss",
    "public_sector",
    "unclear",
  ]),
  commercialBacker: z.string().nullable(),
  confidence: z.number(),
  rationale: z.string(),
});

const BatchSchema = z.object({
  classifications: z.array(ItemSchema),
});

const SYSTEM = `You classify GitHub organizations by what kind of entity they are, for a sales-qualification pipeline.

The buyer being qualified for sells developer tooling (merge queues, CI, code review) on a per-seat subscription. The question behind every classification is: is there a commercial entity here with an engineering budget that could buy seats?

Categories:
- "company" — a commercial business. It sells a product or service. Includes venture-backed startups, public companies, agencies, and consultancies.
- "vendor_backed_oss" — an open-source project whose development is funded and staffed by an identifiable company (e.g. an OSS org operated by a single vendor). Name that company in commercialBacker.
- "foundation" — a neutral foundation, consortium, standards body, or working group. Multi-vendor governance, no single owner. Examples of the shape: CNCF projects, industry alliances.
- "community_oss" — a volunteer or community-run open-source project with no company behind it.
- "public_sector" — a government agency, public university, national lab, or state education body.
- "unclear" — the supplied facts genuinely do not distinguish. Use this rather than guessing.

Hard rules:
1. Use ONLY the facts supplied for each organization. Do not use outside knowledge to invent facts, and never state a detail that is not in the packet.
2. Domain suffix is weak evidence, not proof. A .io or .org domain says little on its own; the description and repository names carry more signal.
3. commercialBacker must be null unless entityType is "vendor_backed_oss".
4. rationale: one sentence, under 25 words, citing the specific fact you relied on.
5. confidence: 0.0-1.0. Be honest — thin packets should score low.
6. Return exactly one entry per organization supplied, with the login copied verbatim.`;

/** A policy call, made in code so it is auditable and not a model judgment. */
function buyerClassOf(entityType: EntityType): BuyerClass {
  if (entityType === "company") return "buyer";
  if (entityType === "vendor_backed_oss") return "indirect";
  return "non_buyer";
}

function packetFor(org: CensusOrg): Record<string, unknown> {
  return {
    login: org.login,
    displayName: org.qualification.name,
    domain: org.qualification.domain,
    description: org.qualification.description,
    publicRepos: org.qualification.publicRepos,
    followers: org.qualification.followers,
    createdAt: org.qualification.createdAt?.slice(0, 10) ?? null,
    queueRepos: org.repos.slice(0, 5).map((r) => ({
      name: r.nameWithOwner,
      description: r.description,
      stars: r.stars,
      contributors: r.contributors,
    })),
  };
}

function cacheKey(packet: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${PROMPT_VERSION}:${CLASSIFY_MODEL}:${JSON.stringify(packet)}`)
    .digest("hex")
    .slice(0, 32);
}

function readCache(key: string): OrgClassification | null {
  const file = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OrgClassification;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: OrgClassification): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
}

/** Turn an unknown-model rejection into something the user can act on. */
async function explainModelError(
  client: OpenAI,
  err: unknown,
  log: (s: string) => void,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (!/model/i.test(message)) return;
  log(`  model "${CLASSIFY_MODEL}" was rejected: ${message}`);
  try {
    const models = await client.models.list();
    const usable = models.data
      .map((m) => m.id)
      .filter((id) => /^(gpt|o\d)/.test(id))
      .sort()
      .slice(0, 25);
    if (usable.length) {
      log(`  models available to this key: ${usable.join(", ")}`);
      log(`  set OPENAI_MODEL=<one of the above> in .env and re-run.`);
    }
  } catch {
    log("  could not list available models; check the key and OPENAI_MODEL.");
  }
}

export interface ClassifyResult {
  classified: number;
  fromCache: number;
  failed: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Classifies orgs in place. Returns counts; never throws — a classification
 * failure leaves the org unclassified rather than sinking the run.
 */
export async function classifyOrgs(
  orgs: CensusOrg[],
  log: (s: string) => void,
): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    classified: 0,
    fromCache: 0,
    failed: 0,
    skipped: false,
  };

  if (!process.env.OPENAI_API_KEY) {
    result.skipped = true;
    result.reason =
      "OPENAI_API_KEY not set — buyer classification skipped (see .env.example)";
    log(`  ${result.reason}`);
    return result;
  }

  // Serve what we can from cache before spending anything.
  const pending: CensusOrg[] = [];
  for (const org of orgs) {
    const cached = readCache(cacheKey(packetFor(org)));
    if (cached) {
      org.classification = cached;
      result.fromCache++;
    } else {
      pending.push(org);
    }
  }
  log(
    `  ${result.fromCache} from cache, ${pending.length} to classify (${CLASSIFY_MODEL})`,
  );
  if (pending.length === 0) return result;

  const client = new OpenAI();
  let explainedModelError = false;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const packets = batch.map(packetFor);
    const batchNo = Math.floor(i / BATCH_SIZE) + 1;
    const batchCount = Math.ceil(pending.length / BATCH_SIZE);

    try {
      const completion = await client.chat.completions.parse({
        model: CLASSIFY_MODEL,
        max_completion_tokens: 8000,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Classify these ${packets.length} GitHub organizations.\n\n${JSON.stringify(packets, null, 2)}`,
          },
        ],
        response_format: zodResponseFormat(BatchSchema, "classifications"),
      });

      const choice = completion.choices[0];
      if (choice?.message.refusal) {
        result.failed += batch.length;
        log(`  batch ${batchNo}: refused — ${choice.message.refusal}`);
        continue;
      }

      const parsed = choice?.message.parsed;
      if (!parsed) {
        result.failed += batch.length;
        log(`  batch ${batchNo}: no parsed output, skipped`);
        continue;
      }

      const byLogin = new Map(
        parsed.classifications.map((c) => [c.login.toLowerCase(), c]),
      );

      for (const org of batch) {
        const item = byLogin.get(org.login.toLowerCase());
        if (!item) {
          result.failed++;
          continue;
        }
        const classification: OrgClassification = {
          entityType: item.entityType,
          // Enforce rule 3 in code rather than trusting the model to hold it.
          commercialBacker:
            item.entityType === "vendor_backed_oss"
              ? item.commercialBacker
              : null,
          buyerClass: buyerClassOf(item.entityType),
          confidence: Math.max(0, Math.min(1, item.confidence)),
          rationale: item.rationale,
          model: CLASSIFY_MODEL,
          promptVersion: PROMPT_VERSION,
        };
        org.classification = classification;
        writeCache(cacheKey(packetFor(org)), classification);
        result.classified++;
      }
      log(`  batch ${batchNo}/${batchCount} — ${batch.length} orgs`);
    } catch (err) {
      result.failed += batch.length;
      log(
        `  batch ${batchNo} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!explainedModelError) {
        explainedModelError = true;
        await explainModelError(client, err, log);
      }
    }
  }

  return result;
}

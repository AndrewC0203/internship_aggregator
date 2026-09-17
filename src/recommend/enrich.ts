import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { distill } from "../model/signature.js";
import { embed, toVectorLiteral } from "../model/ollama.js";
import { EMBED_MODEL, TEMPLATE_VERSION } from "./config.js";
import {
  listingCanonicalText,
  signatureFingerprint,
  validateSignature,
} from "./canonical.js";

// Enrichment pass (spec "Enrichment stage"): ONE code path for backfill and incremental
// refresh — process whatever is stale, in two sub-passes:
//
//   1. SIGNATURE: rows whose stored fingerprint differs from the hash of current inputs +
//      prompt version (content edits, prompt bumps, and never-processed rows all land here).
//      Saving a changed signature CLEARS the embedding in the SAME statement — otherwise a
//      signature-save followed by an embed failure leaves an OLD embedding that still
//      matches current config: eligible for ranking and never retried. With the clear,
//      `embedding IS NULL` is the retry trigger and the usability gate excludes the row.
//   2. EMBED: rows with a signature whose embedding is missing OR was produced by a
//      different model/template than current config. An embedding-model swap re-embeds
//      WITHOUT re-running distillation — the expensive 7B pass is never repeated for a
//      cheap embed-model change.
//
// Staleness lives in the rows (fingerprints written only on successful save), which is what
// makes the pass resumable and crash-safe: re-running after any failure just picks up the
// still-stale rows. No job table, no checkpoints.

export interface EnrichSummary {
  scanned: number;
  signatureRegen: number;
  signatureFailed: number;
  embedded: number;
  embedFailed: number;
  upToDate: number;
}

// Null-safe staleness check (IS DISTINCT FROM semantics — a null stored fingerprint never
// equals a real hash). Exported for tests.
export function needsSignature(
  row: { signatureFingerprint: string | null },
  currentFp: string,
): boolean {
  return row.signatureFingerprint !== currentFp;
}

// Stable batching for embed() calls. Exported for tests.
export function embedBatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const EMBED_BATCH_SIZE = 16;

export async function enrichListings(
  opts: { ids?: number[]; limit?: number } = {},
): Promise<EnrichSummary> {
  const summary: EnrichSummary = {
    scanned: 0,
    signatureRegen: 0,
    signatureFailed: 0,
    embedded: 0,
    embedFailed: 0,
    upToDate: 0,
  };

  // Embed sub-pass, callable repeatedly: everything with a signature but no current-config
  // vector. INTERLEAVED with the signature loop (initial sweep + every SIG_CHUNK distills +
  // final) rather than run once at the end — the 2026-09-14 backfill crash showed why: a
  // signatures-first/embeds-last structure left 1,613 freshly-signed rows with NO vector
  // when the process died, so the rankable corpus never grew during hours of work.
  // Interleaving keeps "usable" advancing continuously; embeds are cheap relative to
  // distills, and the query is idempotent, so repeated sweeps cost ~nothing.
  async function embedPending(): Promise<void> {
    const idFilter = opts.ids
      ? Prisma.sql`AND id IN (${Prisma.join(opts.ids)})`
      : Prisma.empty;
    const toEmbed = await prisma.$queryRaw<Array<{ id: number; title: string; signature: unknown }>>`
      SELECT id, title, signature
      FROM listings
      WHERE is_listed
        AND signature IS NOT NULL
        AND (embedding IS NULL
             OR embedding_model IS DISTINCT FROM ${EMBED_MODEL}
             OR template_version IS DISTINCT FROM ${TEMPLATE_VERSION})
        ${idFilter}
      ORDER BY id ASC
      ${opts.limit ? Prisma.sql`LIMIT ${opts.limit}` : Prisma.empty}`;

    for (const batch of embedBatches(toEmbed, EMBED_BATCH_SIZE)) {
      // A row whose stored signature no longer validates (schema drift) is skipped loudly —
      // it re-enters via a prompt-version bump, never via a silent guess.
      const valid = batch
        .map((r) => ({ id: r.id, title: r.title, sig: validateSignature(r.signature) }))
        .filter((r): r is { id: number; title: string; sig: NonNullable<ReturnType<typeof validateSignature>> } => {
          if (!r.sig) console.error(`[enrich embed] #${r.id} stored signature invalid — skipped`);
          return r.sig !== null;
        });
      if (valid.length === 0) continue;

      try {
        console.log(`[enrich embed] embedding batch of ${valid.length} (through #${valid[valid.length - 1].id})...`);
        const vectors = await embed(
          valid.map((r) => listingCanonicalText(r.title, r.sig, EMBED_MODEL)),
          EMBED_MODEL,
        );
        for (let i = 0; i < valid.length; i++) {
          await prisma.$executeRaw`
            UPDATE listings
            SET embedding = ${toVectorLiteral(vectors[i])}::vector,
                embedding_model = ${EMBED_MODEL},
                template_version = ${TEMPLATE_VERSION}
            WHERE id = ${valid[i].id}`;
          summary.embedded++;
        }
      } catch (err) {
        // Batch-level isolation: these rows stay embedding-NULL and retry next sweep/pass.
        summary.embedFailed += valid.length;
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[enrich embed] batch failed (rows stay NULL, retry next pass): ${reason}`);
      }
    }
  }

  // ── Signatures (with interleaved embed sweeps) ────────────────────────────────────────
  // Fingerprints compare in Node (the hash needs the full input tuple anyway); at ~2k
  // active rows the full scan is trivial and keeps the staleness rule in exactly one place.
  const rows = await prisma.listing.findMany({
    where: { isListed: true, ...(opts.ids ? { id: { in: opts.ids } } : {}) },
    orderBy: { id: "asc" },
    take: opts.limit,
    select: {
      id: true,
      title: true,
      company: true,
      descriptionPlain: true,
      opportunityType: true,
      csField: true,
      signatureFingerprint: true,
    },
  });
  summary.scanned = rows.length;

  const stale = rows.filter((r) => needsSignature(r, signatureFingerprint(r)));

  // Initial sweep: a restart after a crash embeds everything already signed BEFORE paying
  // for a single new distill — the rankable corpus recovers first.
  await embedPending();

  // Sequential like every model loop in this repo: one local Ollama, one request at a time.
  const SIG_CHUNK = 50;
  for (const [i, row] of stale.entries()) {
    const label = `[enrich sig ${i + 1}/${stale.length}] #${row.id} ${row.company} :: "${row.title}"`;
    try {
      console.log(`${label} -> distilling...`);
      const sig = await distill(row);
      // Crash-window rule: signature + fingerprint + embedding-clear land in ONE statement.
      // Fingerprint is computed from the SAME inputs the prompt saw (this row object).
      await prisma.$executeRaw`
        UPDATE listings
        SET signature = ${JSON.stringify(sig)}::jsonb,
            signature_fingerprint = ${signatureFingerprint(row)},
            embedding = NULL, embedding_model = NULL, template_version = NULL
        WHERE id = ${row.id}`;
      summary.signatureRegen++;
    } catch (err) {
      // Per-row isolation, same recovery story as extract.ts: the row keeps its old state
      // (fingerprint still stale) and retries on the next pass.
      summary.signatureFailed++;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${label} -> FAILED (will retry next pass): ${reason}`);
    }
    // Interleaved sweep: freshly-signed rows become rankable within SIG_CHUNK distills of
    // their signature, no matter when (or whether) the full run finishes.
    if ((i + 1) % SIG_CHUNK === 0) await embedPending();
  }

  // Final sweep catches the tail chunk (and, when the signature list was empty, is the
  // whole run — e.g. after an embed-model swap, which re-embeds without re-distilling).
  await embedPending();

  summary.upToDate = summary.scanned - stale.length;
  return summary;
}

export function formatEnrichSummary(s: EnrichSummary): string {
  return (
    `signatures ${s.signatureRegen} regenerated (${s.signatureFailed} failed), ` +
    `embeddings ${s.embedded} written (${s.embedFailed} failed), ` +
    `${s.upToDate}/${s.scanned} scanned rows already current`
  );
}

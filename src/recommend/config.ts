// Recommendation config (Decisions 29-31; spec: finalized_decisions/recommendations.md).
//
// EMBED_MODEL + TEMPLATE_VERSION together ARE the vector-usability gate: a stored embedding
// is used only when its row's embedding_model AND template_version match these. Swapping the
// embed model (env or here) re-embeds every listing WITHOUT re-running distillation — the
// enrichment pass sees the mismatch and regenerates vectors only.
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

// Version of the canonical-text templates in canonical.ts (section wording, task prefixes).
// Bump on ANY template change: old vectors were produced from different text and must not
// be compared against new ones — the gate handles the rest.
// v2 (2026-09-14): skills list removed from the embedded profile text (user decision —
// skills get ~zero ranking weight vs demonstrated experience; screened, see canonical.ts).
export const TEMPLATE_VERSION = 2;

// Version of the distillation prompt (model/signature.ts). Part of the signature
// fingerprint, so bumping it marks every signature stale for the next enrichment pass.
export const SIGNATURE_PROMPT_VERSION = 1;

// Score blend (spec "Ranking"): named constants, VALIDATED at the eval gate 2026-09-14
// (research/embedding-model-bakeoff.md). The spec's starting 0.15 freshness weight churned
// 4-6 of the top-10 with unjudged items on the labeled sample — the blend was remaking the
// feed, not nudging it (cosine similarities compress into ~0.60-0.78, so a 0..1 freshness
// term at 0.15 rivals the whole similarity spread). At 0.05 the churn is 1-2 items with
// zero labeled-irrelevant entrants: nudge, not remake — the chosen behavior.
export const W_SIM = 0.95;
export const W_FRESH = 0.05;
export const FRESHNESS_HALF_LIFE_DAYS = 30;

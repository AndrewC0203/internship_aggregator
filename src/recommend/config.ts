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
export const TEMPLATE_VERSION = 1;

// Version of the distillation prompt (model/signature.ts). Part of the signature
// fingerprint, so bumping it marks every signature stale for the next enrichment pass.
export const SIGNATURE_PROMPT_VERSION = 1;

// Score blend (spec "Ranking"): named constants, start 0.85/0.15; the freshness weight is
// validated at the eval gate — the blend can reorder results, and that must be a CHOSEN
// behavior, not an accident of a magic number.
export const W_SIM = 0.85;
export const W_FRESH = 0.15;
export const FRESHNESS_HALF_LIFE_DAYS = 30;

import { chatJson } from "./ollama.js";
import { validateSignature, type RoleSignature } from "../recommend/canonical.js";
import { canonicalizeSkills } from "../recommend/aliases.js";

// Distillation stage (Decision 31): compress a posting into the role signature that gets
// embedded. A SEPARATE stage/prompt from extract (classifier.ts) on purpose — extract is
// quote-first fact copying with measured accuracy; distillation is abstractive. Mixing them
// risks the validated extract contract. Accepted cost: one extra 7B call per listing.

// Same precedence shape as classifier.ts passModel(): per-pass env > global > default.
// 7B default — distillation is decode-light (a dozen skills + one sentence) and the 14B's
// only benchmarked weakness was hallucination on decode-heavy abstraction (Decision 25).
export function distillModel(env: Record<string, string | undefined> = process.env): string {
  return env.OLLAMA_DISTILL_MODEL ?? env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
}

const DISTILL_SCHEMA = {
  type: "object",
  properties: {
    skills: { type: "array", items: { type: "string" }, maxItems: 12 },
    focus: { type: "string" },
  },
  required: ["skills", "focus"],
} as const;

// The soft-skill ban and boilerplate ban live HERE, in the prompt — they are the whole
// point of distilling (Decision 31: boilerplate carries no ranking signal while pulling
// all scores together).
const DISTILL_SYSTEM = `You distill a job posting into a role signature for matching against candidate resumes.

Return:
- skills: the TECHNICAL skills, tools, languages, and frameworks the role requires or prefers (e.g. "python", "react", "kubernetes"). NEVER include soft skills — no communication of any kind ("structured communication", "written communication"), teamwork, leadership, passion, attention to detail, work ethic, or problem-solving. NEVER include degrees, GPAs, or years of experience. If a skill is not a technology, tool, language, framework, or technical method, leave it out. Lowercase. At most 12.
- focus: ONE sentence describing the role's technical focus — what the person will build or work on. No company name, no benefits, no equal-opportunity boilerplate, no soft skills.`;

// Same cap as classifier.ts: enough for any real signal, bounds a pathological posting.
const MAX_DESC_CHARS = 6000;

export interface DistillInput {
  title: string;
  company: string;
  descriptionPlain: string;
  opportunityType: string | null;
  csField: string | null;
}

// Pure assembly + validation, exported for tests. domains/level are deterministic copies of
// the stored classification (Decision 16 single csField) — the model is trusted only for
// skills + focus, and even those pass validateSignature before anything is saved.
export function assembleSignature(
  out: { skills: string[]; focus: string },
  input: DistillInput,
): RoleSignature | null {
  return validateSignature({
    skills: canonicalizeSkills(out.skills),
    domains: input.csField ? [input.csField] : [],
    level: input.opportunityType ?? "unknown",
    focus: out.focus.trim(),
  });
}

export async function distill(input: DistillInput): Promise<RoleSignature> {
  const user = [
    `Title: ${input.title}`,
    `Company: ${input.company}`,
    "",
    "Description:",
    input.descriptionPlain.slice(0, MAX_DESC_CHARS),
  ].join("\n");

  const out = await chatJson<{ skills: string[]; focus: string }>({
    system: DISTILL_SYSTEM,
    user,
    schema: DISTILL_SCHEMA,
    model: distillModel(),
  });

  const sig = assembleSignature(out, input);
  // A shape-invalid signature is a failed distillation, not a savable abstention: the caller
  // (enrich pass) skips the save, the fingerprint stays stale, and the row retries next pass.
  if (!sig) throw new Error("distillation produced an invalid signature");
  return sig;
}

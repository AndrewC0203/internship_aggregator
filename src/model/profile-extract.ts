import { chatJson } from "./ollama.js";
import { canonicalizeSkills } from "../recommend/aliases.js";

// Resume -> extracted profile (spec "User profile flow"): 14B, quote-grounded (Decision 24
// pattern) — the model may only claim what it can point to in the resume. Every skill and
// the focus sentence carry an evidence quote; groundClaims() drops anything whose evidence
// is not actually in the resume. Writes land in user_profile.extracted_profile ONLY — the
// human approves into `profile`, and nothing downstream reads unapproved content.

// 14B default: profile extraction is one interactive call (not a sweep), so the 14B's
// better instruction-following wins and its extract-speed penalty is irrelevant here.
export function profileModel(env: Record<string, string | undefined> = process.env): string {
  return env.OLLAMA_PROFILE_MODEL ?? env.OLLAMA_MODEL ?? "qwen2.5:14b-instruct";
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    skills: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        // evidence BEFORE name: Ollama's grammar emits fields in schema order, so the model
        // must quote the resume line before naming the skill (same steering trick as
        // classifier.ts degree_evidence — measured to stop title-anchoring).
        properties: { evidence: { type: "string" }, name: { type: "string" } },
        required: ["evidence", "name"],
      },
    },
    focus: {
      type: "object",
      properties: { evidence: { type: "string" }, text: { type: "string" } },
      required: ["evidence", "text"],
    },
  },
  required: ["skills", "focus"],
} as const;

const EXTRACT_SYSTEM = `You extract a candidate profile from a resume. You may ONLY claim things you can quote from the resume text.

Return:
- skills: TECHNICAL skills the resume demonstrates IN USE (languages, frameworks, tools, technical methods). For each: "evidence" = the exact resume phrase from a PROJECT or WORK-EXPERIENCE bullet showing the skill actually being used (copied verbatim), "name" = the skill in lowercase. A standalone skills/technologies/languages LIST is NOT usage evidence — a skill that appears ONLY in such a list must be OMITTED (resumes routinely pad skill lists; demonstrated use is the bar). NEVER include soft skills, and NEVER include a skill the resume merely wishes for ("eager to learn Rust" is NOT a Rust skill). At most 20.
- focus: ONE sentence summarizing the candidate's demonstrated technical experience — what they have actually built or worked on. "evidence" = the resume phrase that best supports it (verbatim quote). Do not include aspirations or objectives; only past/present demonstrated work.`;

interface RawClaims {
  skills: Array<{ name: string; evidence: string }>;
  focus: { text: string; evidence: string };
}

export interface ExtractedProfile {
  skills: string[]; // canonicalized, resume-evidenced only
  focus: string;
  dropped: string[]; // claims rejected by grounding — surfaced in the UI, never silent
}

// Whitespace-normalized, case-insensitive containment: the model copies quotes across line
// breaks and the resume may have ragged spacing; neither should fail a truthful quote.
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

// Pure grounding seam, exported for tests. Skills with bad evidence are dropped (and
// reported); a focus with bad evidence THROWS — a profile without a grounded focus sentence
// is not publishable, and silently inventing one would defeat the whole contract.
export function groundClaims(raw: RawClaims, resumeText: string): ExtractedProfile {
  const haystack = normalize(resumeText);
  const grounded = (evidence: string): boolean =>
    evidence.trim().length > 0 && haystack.includes(normalize(evidence));

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const s of raw.skills) {
    if (grounded(s.evidence)) kept.push(s.name);
    else dropped.push(s.name.trim().toLowerCase());
  }

  if (!grounded(raw.focus.evidence)) {
    throw new Error("profile extraction failed grounding: focus evidence not found in resume");
  }

  return { skills: canonicalizeSkills(kept), focus: raw.focus.text.trim(), dropped };
}

export async function extractProfile(resumeText: string): Promise<ExtractedProfile> {
  const out = await chatJson<RawClaims>({
    system: EXTRACT_SYSTEM,
    user: `Resume:\n${resumeText}`,
    schema: EXTRACT_SCHEMA,
    model: profileModel(),
  });
  return groundClaims(out, resumeText);
}

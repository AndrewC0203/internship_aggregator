// Skill alias map — applied before BOTH embedding and matched-skills explanations, so
// "postgres" on a resume matches "PostgreSQL" in a posting in the vector space AND in the
// rendered overlap chips (one normalization, two consumers — they must never disagree).
//
// Key: lowercase surface form; value: canonical form. Deliberately small and curated:
// an alias only earns a row when both spellings plausibly appear in resumes/postings.
// Unknown skills pass through lowercased — the map canonicalizes, it never filters.
const ALIASES: Record<string, string> = {
  postgres: "postgresql",
  "postgre sql": "postgresql",
  js: "javascript",
  ts: "typescript",
  golang: "go",
  "react.js": "react",
  reactjs: "react",
  "node.js": "node",
  nodejs: "node",
  "vue.js": "vue",
  vuejs: "vue",
  k8s: "kubernetes",
  tf: "tensorflow",
  sklearn: "scikit-learn",
  "scikit learn": "scikit-learn",
  gcp: "google cloud",
  "amazon web services": "aws",
  "c sharp": "c#",
  "objective c": "objective-c",
  "ci/cd": "cicd",
  "ci-cd": "cicd",
};

export function canonicalizeSkills(raw: string[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const s = r.trim().toLowerCase();
    if (!s) continue;
    out.add(ALIASES[s] ?? s);
  }
  // Sorted so canonical text (and therefore embeddings + fingerprints) never depends on
  // the order a model happened to emit skills in.
  return [...out].sort();
}

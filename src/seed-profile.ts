// One-off: publish an approved profile from a local resume + questionnaire, against
// whatever DATABASE_URL is set (e.g. the hosted production DB) — see DECISIONS.md Decision
// 36. Needs `ollama serve` running locally; ranking itself never calls Ollama afterward.
// `npx tsx src/seed-profile.ts [resumePath] [questionnairePath]`
import { readFile } from "node:fs/promises";
import { prisma } from "./db.js";
import { extractProfile } from "./model/profile-extract.js";
import { ensureProfileRow, publishProfile } from "./recommend/profile.js";
import { parseQuestionnaire } from "./recommend/questionnaire.js";

async function main() {
  const resumePath = process.argv[2] ?? "resume.local.txt";
  const questionnairePath = process.argv[3] ?? "questionnaire.local.json";

  const resumeText = await readFile(resumePath, "utf-8");
  const questionnaireRaw = JSON.parse(await readFile(questionnairePath, "utf-8"));
  console.log(`read ${resumeText.length} chars from ${resumePath}`);

  console.log("connecting to DB...");
  await ensureProfileRow(prisma);
  const row = await prisma.userProfile.findUnique({ where: { id: 1 }, select: { revision: true } });
  console.log(`DB ok, current revision ${row?.revision ?? 0}`);

  console.log("extracting profile via 14B model (this can take 30-90s)...");
  const extracted = await extractProfile(resumeText);
  console.log(`extracted ${extracted.skills.length} skills`);
  if (extracted.dropped.length) {
    console.log("dropped (ungrounded claims):", extracted.dropped);
  }

  console.log("embedding + publishing...");
  const result = await publishProfile(prisma, {
    profile: { skills: extracted.skills, focus: extracted.focus },
    questionnaire: parseQuestionnaire(questionnaireRaw),
    expectedRevision: row?.revision ?? 0,
  });
  console.log(result);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

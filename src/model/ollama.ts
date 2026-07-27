// Minimal typed client for a local Ollama server (Decision 12). We need exactly one thing:
// send a system+user prompt, force JSON-schema-constrained output, and get the parsed object
// back. The model runs locally (Qwen2.5) — no listing data leaves the machine.
//
// Config via env, with defaults matching the decision:
//   OLLAMA_URL   — server base URL (default http://localhost:11434)
//   OLLAMA_MODEL — model tag; default is the 14B primary. Set to "qwen2.5:7b-instruct" if
//                  the initial sweep is too slow (the throughput fallback from Decision 12).

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:14b-instruct";

interface ChatJsonOptions {
  system: string;
  user: string;
  // A JSON Schema the model output is constrained to (Ollama's `format` grammar). This
  // guarantees the reply is parseable JSON of the right shape — we never free-text-parse
  // a model response, which is the classic small-local-model failure mode.
  schema: Record<string, unknown>;
}

export async function chatJson<T>({ system, user, schema }: ChatJsonOptions): Promise<T> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: schema, // structured-output grammar; response is constrained to this schema
      // temperature 0: classification/extraction want determinism, not creativity. (This is
      // Ollama, not the Claude API — local models still take sampling params.)
      options: { temperature: 0 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as { message?: { content?: string } };
  const content = body.message?.content;
  if (!content) {
    throw new Error("Ollama returned no message content");
  }
  // `format` guarantees valid JSON, so a parse failure here is a real bug (bad schema, wrong
  // Ollama version) worth surfacing rather than swallowing.
  return JSON.parse(content) as T;
}

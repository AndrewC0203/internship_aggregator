// Minimal typed client for a local Ollama server (Decision 12). We need exactly one thing:
// send a system+user prompt, force JSON-schema-constrained output, and get the parsed object
// back. The model runs locally (Qwen2.5) — no listing data leaves the machine.
//
// Config via env, with defaults matching the decision:
//   OLLAMA_URL        — server base URL (default http://localhost:11434)
//   OLLAMA_MODEL      — model tag; default is the 7B. This was the 14B originally, with 7B
//                       named as "the throughput fallback"; benchmarking made that swap.
//                       Measured on this machine (M4 Pro, 24 GB): a classify call is ~7.4s
//                       on the 14B and 87% of that is PREFILL, not generation — we send
//                       ~1,450 tokens and get back ~21. Prefill scales with parameter count,
//                       so the 7B roughly halves it, and drops resident memory 9.5 GB → ~5 GB
//                       (the 14B alone pushed this machine into swap).
//                       Set OLLAMA_MODEL=qwen2.5:14b-instruct to go back.
//                       See research/local-model-performance.md.
//   OLLAMA_TIMEOUT_MS — per-request timeout (default 120s). Local inference is legitimately
//                       slow, so this is generous — it exists to kill a truly HUNG request
//                       (a pathological input that never returns), not a slow-but-progressing
//                       one. Without it, one hung call stalls the whole sequential run
//                       forever, since the filter/extract loops block on each request.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000);

interface ChatJsonOptions {
  system: string;
  user: string;
  // A JSON Schema the model output is constrained to (Ollama's `format` grammar). This
  // guarantees the reply is parseable JSON of the right shape — we never free-text-parse
  // a model response, which is the classic small-local-model failure mode.
  schema: Record<string, unknown>;
}

export async function chatJson<T>({ system, user, schema }: ChatJsonOptions): Promise<T> {
  // Mirror the fetch-timeout pattern from greenhouse/fetch.ts: the LOCAL model call is far
  // more likely to stall than the remote HTTP GET, so it deserves the same guard.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
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
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Ollama request timed out after ${TIMEOUT_MS}ms (model "${OLLAMA_MODEL}")`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

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

// Minimal typed client for a local Ollama server (Decision 12). We need exactly one thing:
// send a system+user prompt, force JSON-schema-constrained output, and get the parsed object
// back. The model runs locally (Qwen2.5) — no listing data leaves the machine.
//
// Config via env, with defaults matching the decision:
//   OLLAMA_URL        — server base URL (default http://localhost:11434)
//   OLLAMA_MODEL      — GLOBAL model override + default for callers that don't pass one.
//                       Since Decision 25 the two pipeline passes run different models by
//                       default (classify 14B / extract 7B — see passModel() in classifier.ts
//                       and research/model-rebenchmark-m5max.md); setting OLLAMA_MODEL forces
//                       ONE model everywhere, which is what bench scripts and A/B reclassify
//                       runs want. History: the 24GB M4 Pro forced a 7B-everywhere era
//                       (research/local-model-performance.md); the M5 Max/128GB removed it.
//   OLLAMA_TIMEOUT_MS — per-request timeout (default 120s). Local inference is legitimately
//                       slow, so this is generous — it exists to kill a truly HUNG request
//                       (a pathological input that never returns), not a slow-but-progressing
//                       one. Without it, one hung call stalls the whole sequential run
//                       forever, since the filter/extract loops block on each request.
//   OLLAMA_MAX_RETRIES — retries for a TRANSIENT failure (network error, timeout, 429, 5xx)
//                       before giving up on one call. Default 3. Mirrors the discovery CDX
//                       layer's `withCdxRetry` (src/discovery/greenhouse.ts) — same shape
//                       (exponential backoff, injectable sleep for tests), but kept as its own
//                       copy rather than a shared helper: that file's comment already decided
//                       retry stays scoped per-layer, since Ollama and Common Crawl want
//                       different classifiers (a 400 here means a bad schema, not "not found").
//   OLLAMA_RETRY_BASE_MS — backoff base (default 1s: 1s, 2s, 4s).

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000);
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES ?? 3);
const OLLAMA_RETRY_BASE_MS = Number(process.env.OLLAMA_RETRY_BASE_MS ?? 1_000);

interface ChatJsonOptions {
  system: string;
  user: string;
  // A JSON Schema the model output is constrained to (Ollama's `format` grammar). This
  // guarantees the reply is parseable JSON of the right shape — we never free-text-parse
  // a model response, which is the classic small-local-model failure mode.
  schema: Record<string, unknown>;
  // Per-call model tag (Decision 25: classify and extract run different models). Falls back
  // to the global OLLAMA_MODEL default so other callers are unaffected.
  model?: string;
}

// Thrown for a chat request that reached (or tried to reach) the Ollama server — network error,
// timeout, or a non-2xx response. `status` is undefined for a network/timeout failure (there was
// no HTTP response), matching DiscoveryFetchError's shape in discovery/greenhouse.ts.
export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

// Retryable = transient: no status at all (network/timeout — Ollama restarting, briefly
// unreachable), 429 (busy), or any 5xx. A 4xx like 400 means the request itself is malformed
// (bad schema, wrong model tag) — a real bug that retrying can't fix, so it's fatal, same as a
// JSON-parse failure below (never wrapped in OllamaError, so isRetryableOllamaError rejects it).
export function isRetryableOllamaError(err: unknown): boolean {
  if (!(err instanceof OllamaError)) return false;
  const { status } = err;
  return status === undefined || status === 429 || status >= 500;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Run `fn`, retrying transient Ollama failures with exponential backoff. Injectable sleep so
// tests run instantly. Throws the last error once retries are exhausted or on a fatal error.
export async function withOllamaRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? OLLAMA_MAX_RETRIES;
  const baseMs = opts.baseMs ?? OLLAMA_RETRY_BASE_MS;
  const sleepFn = opts.sleepFn ?? sleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableOllamaError(err) || attempt >= retries) throw err;
      const delay = baseMs * 2 ** attempt;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`Ollama call failed: ${reason} — retry ${attempt + 1}/${retries} in ${delay}ms`);
      await sleepFn(delay);
    }
  }
}

export async function chatJson<T>(opts: ChatJsonOptions): Promise<T> {
  return withOllamaRetry(() => chatJsonOnce<T>(opts));
}

async function chatJsonOnce<T>({ system, user, schema, model }: ChatJsonOptions): Promise<T> {
  const modelTag = model ?? OLLAMA_MODEL;
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
        model: modelTag,
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
      throw new OllamaError(
        `Ollama request timed out after ${TIMEOUT_MS}ms (model "${modelTag}")`,
      );
    }
    // A network error (ECONNREFUSED — Ollama not running/restarting) has no status, so it's
    // classified retryable, same as a timeout.
    const reason = err instanceof Error ? err.message : String(err);
    throw new OllamaError(`Ollama network error: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new OllamaError(`Ollama ${res.status}: ${await res.text()}`, res.status);
  }

  const body = (await res.json()) as { message?: { content?: string } };
  const content = body.message?.content;
  if (!content) {
    throw new Error("Ollama returned no message content");
  }
  // `format` guarantees valid JSON, so a parse failure here is a real bug (bad schema, wrong
  // Ollama version) worth surfacing rather than swallowing — NOT wrapped in OllamaError, so
  // withOllamaRetry treats it as fatal (retrying can't fix a schema bug).
  return JSON.parse(content) as T;
}

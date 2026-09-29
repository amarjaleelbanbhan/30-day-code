import "server-only";

// Provider-independent LLM + embedding layer. Supports fully local (Ollama or any OpenAI-compatible server),
// cloud providers, or none (search-only). Keys and URLs stay on the server.
//
//   LLM_PROVIDER        ollama | openai | anthropic | none           (default: none)
//   LLM_BASE_URL        e.g. http://localhost:11434 (ollama), http://localhost:8080/v1 (openai-compatible)
//   LLM_MODEL           any model name the server provides — never hard-coded
//   LLM_API_KEY         optional for local servers
//   LLM_CONTEXT_TOKENS  optional override of the detected context window
//   EMBEDDING_PROVIDER  ollama | openai | none                         (default: none)
//   EMBEDDING_BASE_URL / EMBEDDING_MODEL / EMBEDDING_API_KEY
//   EMBEDDING_QUERY_PREFIX / EMBEDDING_DOCUMENT_PREFIX   optional (auto-detected for nomic/e5/bge style models)
// Legacy variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL, ...) are still honoured.

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type CompleteOpts = { system: string; messages: ChatMessage[]; maxTokens?: number; temperature?: number };

export interface LLM {
  readonly provider: string;
  readonly model: string;
  complete(opts: CompleteOpts): Promise<string>;
  /** Usable context window in tokens (detected where the provider exposes it). */
  contextTokens(): Promise<number>;
}

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  /** Identity stored with every vector; vectors from different identities are never compared. */
  readonly key: string;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

const env = (k: string) => process.env[k]?.trim() || undefined;
const trimSlash = (u: string) => u.replace(/\/+$/, "");
const MAX_CTX_DEFAULT = 16384;

async function http<T>(url: string, init: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 180_000) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// ---------------- LLMs ----------------

class OllamaLLM implements LLM {
  readonly provider = "ollama";
  private ctx: number | null = null;
  constructor(private base: string, readonly model: string, private override?: number) {}
  async contextTokens() {
    if (this.override) return this.override;
    if (this.ctx) return this.ctx;
    try {
      const info = await http<{ model_info?: Record<string, unknown>; parameters?: string }>(`${this.base}/api/show`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.model }), timeoutMs: 10_000,
      });
      const fromInfo = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
      const fromParams = info.parameters?.match(/num_ctx\s+(\d+)/)?.[1];
      const n = Number(fromParams ?? fromInfo ?? 0);
      this.ctx = Math.min(n > 0 ? n : 4096, MAX_CTX_DEFAULT);
    } catch {
      this.ctx = 4096;
    }
    return this.ctx;
  }
  async complete({ system, messages, maxTokens = 2000, temperature = 0.1 }: CompleteOpts) {
    const num_ctx = await this.contextTokens();
    const data = await http<{ message?: { content?: string } }>(`${this.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model, stream: false,
        messages: [{ role: "system", content: system }, ...messages],
        options: { num_ctx, num_predict: maxTokens, temperature },
      }),
    });
    return data.message?.content ?? "";
  }
}

class OpenAICompatLLM implements LLM {
  readonly provider = "openai";
  constructor(private base: string, private key: string | undefined, readonly model: string, private ctx: number) {}
  async contextTokens() { return this.ctx; }
  async complete({ system, messages, maxTokens = 2000, temperature = 0.1 }: CompleteOpts) {
    const data = await http<{ choices: { message: { content: string } }[] }>(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, temperature, messages: [{ role: "system", content: system }, ...messages] }),
    });
    return data.choices[0]?.message.content ?? "";
  }
}

class AnthropicLLM implements LLM {
  readonly provider = "anthropic";
  constructor(private key: string, readonly model: string, private ctx: number) {}
  async contextTokens() { return this.ctx; }
  async complete({ system, messages, maxTokens = 2000, temperature = 0.1 }: CompleteOpts) {
    const data = await http<{ content: { type: string; text?: string }[] }>("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, temperature, system, messages }),
    });
    return data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  }
}

export function getLLM(): LLM | null {
  const p = (env("LLM_PROVIDER") ?? "none").toLowerCase();
  const override = Number(env("LLM_CONTEXT_TOKENS") ?? 0) || undefined;
  if (p === "ollama") {
    const model = env("LLM_MODEL");
    return model ? new OllamaLLM(trimSlash(env("LLM_BASE_URL") ?? "http://localhost:11434"), model, override) : null;
  }
  if (p === "openai") {
    const model = env("LLM_MODEL") ?? env("OPENAI_MODEL");
    const base = env("LLM_BASE_URL") ?? env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
    const key = env("LLM_API_KEY") ?? env("OPENAI_API_KEY");
    return model ? new OpenAICompatLLM(trimSlash(base), key, model, override ?? MAX_CTX_DEFAULT) : null;
  }
  if (p === "anthropic") {
    const key = env("LLM_API_KEY") ?? env("ANTHROPIC_API_KEY");
    const model = env("LLM_MODEL") ?? env("ANTHROPIC_MODEL");
    return key && model ? new AnthropicLLM(key, model, override ?? 100_000) : null;
  }
  return null;
}

// ---------------- Embeddings ----------------

/** Known retrieval prefixes for asymmetric embedding models (overridable via env). */
function prefixes(model: string): { query: string; document: string } {
  const q = process.env.EMBEDDING_QUERY_PREFIX, d = process.env.EMBEDDING_DOCUMENT_PREFIX;
  if (q !== undefined || d !== undefined) return { query: q ?? "", document: d ?? "" };
  const m = model.toLowerCase();
  if (m.includes("nomic")) return { query: "search_query: ", document: "search_document: " };
  if (/\be5\b|e5-/.test(m)) return { query: "query: ", document: "passage: " };
  if (m.includes("bge") && !m.includes("m3")) return { query: "Represent this sentence for searching relevant passages: ", document: "" };
  if (m.includes("mxbai")) return { query: "Represent this sentence for searching relevant passages: ", document: "" };
  return { query: "", document: "" };
}

abstract class BaseEmbedder implements Embedder {
  abstract readonly provider: string;
  readonly key: string;
  private px: { query: string; document: string };
  constructor(readonly model: string, provider: string) {
    this.px = prefixes(model);
    const custom = process.env.EMBEDDING_QUERY_PREFIX !== undefined || process.env.EMBEDDING_DOCUMENT_PREFIX !== undefined;
    this.key = `${provider}:${model}${custom ? `#${this.px.query}|${this.px.document}` : ""}`;
  }
  protected abstract raw(texts: string[]): Promise<number[][]>;
  async embed(texts: string[], kind: "query" | "document") {
    const p = kind === "query" ? this.px.query : this.px.document;
    const out = await this.raw(texts.map((t) => p + t));
    if (out.length !== texts.length) throw new Error(`Embedder returned ${out.length} vectors for ${texts.length} inputs`);
    return out;
  }
}

class OllamaEmbedder extends BaseEmbedder {
  readonly provider = "ollama";
  constructor(private base: string, model: string) { super(model, "ollama"); }
  protected async raw(texts: string[]) {
    const data = await http<{ embeddings: number[][] }>(`${this.base}/api/embed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts, truncate: true }), timeoutMs: 120_000,
    });
    return data.embeddings;
  }
}

class OpenAICompatEmbedder extends BaseEmbedder {
  readonly provider = "openai";
  constructor(private base: string, private apiKey: string | undefined, model: string) { super(model, "openai"); }
  protected async raw(texts: string[]) {
    const data = await http<{ data: { index: number; embedding: number[] }[] }>(`${this.base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input: texts }), timeoutMs: 120_000,
    });
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export function getEmbedder(): Embedder | null {
  const legacyUrl = env("EMBEDDING_BASE_URL");
  const p = (env("EMBEDDING_PROVIDER") ?? (legacyUrl ? "openai" : "none")).toLowerCase();
  const model = env("EMBEDDING_MODEL");
  if (!model) return null;
  if (p === "ollama") return new OllamaEmbedder(trimSlash(legacyUrl ?? env("LLM_BASE_URL") ?? "http://localhost:11434"), model);
  if (p === "openai") return new OpenAICompatEmbedder(trimSlash(legacyUrl ?? "https://api.openai.com/v1"), env("EMBEDDING_API_KEY"), model);
  return null;
}

// ---------------- Capability detection ----------------

export type Capabilities = {
  mode: "local" | "cloud" | "mixed" | "search-only";
  llm: { provider: string; model: string | null; available: boolean; contextTokens?: number; error?: string };
  embeddings: { provider: string; model: string | null; key: string | null; available: boolean; dims?: number; error?: string };
};

let capCache: { at: number; value: Capabilities } | null = null;

const isLocalUrl = (u: string | undefined) => !!u && /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[\w-]+\.local\b|host\.docker\.internal)/.test(u.replace(/^https?:\/\//, ""));

/** Probes the configured providers (cached for 60 s). Never throws. */
export async function capabilities(force = false): Promise<Capabilities> {
  if (!force && capCache && Date.now() - capCache.at < 60_000) return capCache.value;
  const llm = getLLM();
  const emb = getEmbedder();
  const out: Capabilities = {
    mode: "search-only",
    llm: { provider: llm?.provider ?? (env("LLM_PROVIDER") ?? "none"), model: llm?.model ?? null, available: false },
    embeddings: { provider: emb?.provider ?? (env("EMBEDDING_PROVIDER") ?? "none"), model: emb?.model ?? null, key: emb?.key ?? null, available: false },
  };
  await Promise.all([
    (async () => {
      if (!llm) return;
      try {
        if (llm.provider === "ollama") {
          const base = trimSlash(env("LLM_BASE_URL") ?? "http://localhost:11434");
          const tags = await http<{ models: { name: string; model?: string }[] }>(`${base}/api/tags`, { timeoutMs: 5000 });
          const names = tags.models.flatMap((m) => [m.name, m.model ?? ""]);
          if (!names.some((n) => n === llm.model || n === `${llm.model}:latest`)) throw new Error(`model "${llm.model}" is not pulled (ollama pull ${llm.model})`);
        }
        out.llm.contextTokens = await llm.contextTokens();
        out.llm.available = true;
      } catch (e) {
        out.llm.error = e instanceof Error ? e.message : String(e);
      }
    })(),
    (async () => {
      if (!emb) return;
      try {
        const [v] = await emb.embed(["capability probe"], "query");
        out.embeddings.dims = v?.length;
        out.embeddings.available = !!v?.length;
      } catch (e) {
        out.embeddings.error = e instanceof Error ? e.message : String(e);
      }
    })(),
  ]);
  const llmLocal = out.llm.provider === "ollama" || (out.llm.provider === "openai" && isLocalUrl(env("LLM_BASE_URL") ?? env("OPENAI_BASE_URL")));
  const embLocal = out.embeddings.provider === "ollama" || (out.embeddings.provider === "openai" && isLocalUrl(env("EMBEDDING_BASE_URL")));
  const parts = [out.llm.available && (llmLocal ? "local" : "cloud"), out.embeddings.available && (embLocal ? "local" : "cloud")].filter(Boolean);
  out.mode = !out.llm.available ? "search-only" : parts.every((p) => p === "local") ? "local" : parts.every((p) => p === "cloud") ? "cloud" : "mixed";
  capCache = { at: Date.now(), value: out };
  return out;
}

/** Rough token estimate (≈4 chars/token for English prose); used only for budgeting. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

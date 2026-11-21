import type { EmbeddingsConfig } from "./config.ts";

export interface Embedder {
  /** Stored beside each vector so a change of model never compares vectors from two spaces. */
  model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

const TIMEOUT_MS = 30_000;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`embeddings: HTTP ${response.status} from ${new URL(url).host}`);
  return response.json();
}

function vectors(value: unknown, count: number): number[][] {
  if (!Array.isArray(value) || value.length !== count || !value.every((row) => Array.isArray(row) && row.every((n) => typeof n === "number"))) {
    throw new Error("embeddings: the provider answered without one vector per text");
  }
  return value as number[][];
}

export function createEmbedder(config: EmbeddingsConfig): Embedder | null {
  if (config.provider === "none") return null;
  if (config.provider === "ollama") {
    return {
      model: `ollama:${config.model}`,
      async embed(texts) {
        if (!texts.length) return [];
        const answer = (await postJson(new URL("/api/embed", config.url).toString(), { model: config.model, input: texts })) as { embeddings?: unknown };
        return vectors(answer.embeddings, texts.length);
      },
    };
  }
  return {
    model: `openai:${config.model}`,
    async embed(texts) {
      if (!texts.length) return [];
      const base = config.url.endsWith("/") ? config.url : `${config.url}/`;
      const answer = (await postJson(new URL("embeddings", base).toString(), { model: config.model, input: texts }, config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})) as { data?: { embedding?: unknown; index?: number }[] };
      const rows = [...(answer.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((row) => row.embedding);
      return vectors(rows, texts.length);
    },
  };
}

export function toPgVector(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

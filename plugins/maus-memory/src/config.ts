import { z } from "zod";

const providerUrl = z.string().url();

const embeddingsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("none") }),
  z.object({ provider: z.literal("ollama"), url: providerUrl, model: z.string().min(1) }),
  z.object({ provider: z.literal("openai"), url: providerUrl, model: z.string().min(1), apiKey: z.string().optional() }),
]);

const llmSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("none") }),
  z.object({ provider: z.literal("anthropic"), url: providerUrl, model: z.string().min(1), apiKey: z.string().min(1) }),
  z.object({ provider: z.literal("openai"), url: providerUrl, model: z.string().min(1), apiKey: z.string().optional() }),
  z.object({ provider: z.literal("claude-cli"), command: z.string().min(1), model: z.string().min(1) }),
]);

export type EmbeddingsConfig = z.infer<typeof embeddingsSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;

const configSchema = z.object({
  databaseUrl: z.string().min(1),
  /** Every HTTP call must carry it as a bearer token; the MCP server talks to the database directly. */
  token: z.string().min(16),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(8787),
  embeddings: embeddingsSchema,
  llm: llmSchema,
  dream: z.object({
    /** A bot dreams once its chats have been quiet this long, or sooner once this many turns wait. */
    quietMs: z.number().int().min(0).default(10 * 60_000),
    pendingTurns: z.number().int().min(1).default(20),
    batchChars: z.number().int().min(1_000).default(12_000),
    tickMs: z.number().int().min(1_000).default(60_000),
  }),
});

export type Config = z.infer<typeof configSchema>;

type Env = Record<string, string | undefined>;

function embeddingsFromEnv(env: Env): EmbeddingsConfig {
  const provider = env.MAUS_EMBEDDINGS ?? "none";
  if (provider === "ollama") return { provider, url: env.MAUS_EMBEDDINGS_URL ?? "http://127.0.0.1:11434", model: env.MAUS_EMBEDDINGS_MODEL ?? "bge-m3" };
  if (provider === "openai") return { provider, url: env.MAUS_EMBEDDINGS_URL ?? "", model: env.MAUS_EMBEDDINGS_MODEL ?? "", apiKey: env.MAUS_EMBEDDINGS_KEY };
  return embeddingsSchema.parse({ provider });
}

function llmFromEnv(env: Env): LlmConfig {
  const provider = env.MAUS_LLM ?? "none";
  if (provider === "anthropic") return { provider, url: env.MAUS_LLM_URL ?? "https://api.anthropic.com", model: env.MAUS_LLM_MODEL ?? "", apiKey: env.MAUS_LLM_KEY ?? "" };
  if (provider === "openai") return { provider, url: env.MAUS_LLM_URL ?? "", model: env.MAUS_LLM_MODEL ?? "", apiKey: env.MAUS_LLM_KEY };
  if (provider === "claude-cli") return { provider, command: env.MAUS_LLM_COMMAND ?? "claude", model: env.MAUS_LLM_MODEL ?? "haiku" };
  return llmSchema.parse({ provider });
}

const optionalInt = (value: string | undefined) => (value === undefined || value === "" ? undefined : Number(value));

export function loadConfig(env: Env = process.env): Config {
  return configSchema.parse({
    databaseUrl: env.MAUS_DATABASE_URL ?? env.DATABASE_URL,
    token: env.MAUS_MEMORY_TOKEN,
    host: env.MAUS_HOST || undefined,
    port: optionalInt(env.MAUS_PORT),
    embeddings: embeddingsFromEnv(env),
    llm: llmFromEnv(env),
    dream: {
      quietMs: optionalInt(env.MAUS_DREAM_QUIET_MS),
      pendingTurns: optionalInt(env.MAUS_DREAM_PENDING_TURNS),
      batchChars: optionalInt(env.MAUS_DREAM_BATCH_CHARS),
      tickMs: optionalInt(env.MAUS_DREAM_TICK_MS),
    },
  });
}

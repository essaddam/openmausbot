import { z } from "zod";
import { allowedServerOrigin } from "../shared/private-host.ts";
import type { CaptureTurn } from "./memory-capture.ts";
import type { RecallPassage } from "./recall.ts";

/** `config.json` → `memory.external`: a memory service beside the app (plugins/maus-memory) that receives captured turns and adds its recall. */
export const externalMemoryConfigSchema = z.object({
  /** Base URL: https, or http on this computer or a private network. OMB_EXTERNAL_MEMORY_URL wins over the file. */
  url: z.string().url(),
  /** Bearer token the service expects. OMB_EXTERNAL_MEMORY_TOKEN wins over the file. */
  token: z.string().max(512).optional(),
  /** How long a turn waits for recall before going on without it (ms). Default 1500. */
  recallTimeoutMs: z.number().int().min(100).max(10_000).optional(),
}).strict();

export type ExternalMemoryConfig = z.infer<typeof externalMemoryConfigSchema>;

export interface ExternalMemoryTurn {
  botId: string;
  botName: string;
  threadId: string;
  turn: CaptureTurn;
}

export interface ExternalMemory {
  enabledFor(bot: { memoryEnabled?: boolean } | undefined): boolean;
  noteTurn(input: ExternalMemoryTurn): void;
  recall(botId: string, message: string): Promise<RecallPassage[]>;
  /** Recall for a turn, or nothing when the bot's memory or automatic recall is off. */
  recallFor(bot: { memoryEnabled?: boolean }, memoryId: string, message: string, autoRecall: boolean): Promise<RecallPassage[]>;
  /** The facts the service marked as needed in every conversation, as last fetched for this bot. */
  corePrompt(botId: string): string;
  /** Fetches those facts ahead of a bot's first turn after a start. */
  warm(botIds: readonly string[]): Promise<void>;
  pending(): number;
  stop(): void;
}

export const DEFAULT_RECALL_TIMEOUT_MS = 1_500;
const SEND_TIMEOUT_MS = 5_000;
const MAX_QUEUED = 500;
const RETRY_MS = [5_000, 30_000, 120_000, 600_000];
const CORE_LABEL = "long-term memory (core)";
const PASSAGE_LABEL = "long-term memory";

interface RecallAnswer {
  core?: unknown;
  passages?: unknown;
}

export function resolveExternalMemoryConfig(file: ExternalMemoryConfig | undefined, env: NodeJS.ProcessEnv): ExternalMemoryConfig | null {
  const url = env.OMB_EXTERNAL_MEMORY_URL?.trim() || file?.url;
  if (!url) return null;
  const token = env.OMB_EXTERNAL_MEMORY_TOKEN?.trim() || file?.token;
  return { url, ...(token ? { token } : {}), ...(file?.recallTimeoutMs ? { recallTimeoutMs: file.recallTimeoutMs } : {}) };
}

/** Turns carry the person's own words: they go only to https or to a private network, never in clear over the internet. */
export function externalMemoryUrlAllowed(url: string): boolean {
  return allowedServerOrigin(url);
}

function lines(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string" && Boolean(line.trim())).map((line) => line.trim().slice(0, 600)).slice(0, max) : [];
}

function passages(value: unknown): RecallPassage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): RecallPassage[] => {
    const item = raw as { label?: unknown; at?: unknown; snippet?: unknown } | null;
    if (!item || typeof item.snippet !== "string" || !item.snippet.trim()) return [];
    const label = typeof item.label === "string" && item.label.trim() ? `${PASSAGE_LABEL} · ${item.label.trim().slice(0, 60)}` : PASSAGE_LABEL;
    return [{ source: "memory", label, ...(typeof item.at === "number" ? { at: item.at } : {}), snippet: item.snippet.slice(0, 800) }];
  }).slice(0, 8);
}

export function createExternalMemory(deps: {
  config: () => ExternalMemoryConfig | null;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  now?: () => number;
}): ExternalMemory {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? Date.now;
  const queue: { body: string; tries: number }[] = [];
  const core = new Map<string, string[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refusedUrl = "";

  function target(): ExternalMemoryConfig | null {
    const config = deps.config();
    if (!config) return null;
    if (!externalMemoryUrlAllowed(config.url)) {
      if (refusedUrl !== config.url) log(`external memory: ${config.url} is refused — use https, or http on this computer or a private network`);
      refusedUrl = config.url;
      return null;
    }
    return config;
  }

  async function post(config: ExternalMemoryConfig, path: string, body: string, timeoutMs: number): Promise<Response> {
    const base = config.url.endsWith("/") ? config.url : `${config.url}/`;
    return doFetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  }

  function schedule(delay: number): void {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
    timer.unref?.();
  }

  async function flush(): Promise<void> {
    const config = target();
    if (!config) return;
    while (queue.length) {
      const next = queue[0]!;
      try {
        const response = await post(config, "v1/turns", next.body, SEND_TIMEOUT_MS);
        if (response.status >= 500 || response.status === 429) throw new Error(`HTTP ${response.status}`);
        if (!response.ok) log(`external memory: a turn was refused (HTTP ${response.status}) and dropped`);
        const sent = queue.indexOf(next);
        if (sent >= 0) queue.splice(sent, 1);
      } catch (error) {
        next.tries += 1;
        schedule(RETRY_MS[Math.min(next.tries - 1, RETRY_MS.length - 1)]!);
        if (next.tries === 1) log(`external memory: turns are waiting for the service (${(error as Error).message})`);
        return;
      }
    }
  }

async function recall(botId: string, message: string): Promise<RecallPassage[]> {
    const config = target();
    if (!config) return [];
    try {
      const response = await post(config, "v1/recall", JSON.stringify({ botId, message }), config.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const answer = (await response.json()) as RecallAnswer;
      core.set(botId, lines(answer.core, 40));
      return passages(answer.passages);
    } catch (error) {
      log(`external memory: recall skipped for ${botId} (${(error as Error).message})`);
      return [];
    }
  }

  return {
    enabledFor: (bot) => Boolean(bot) && bot!.memoryEnabled !== false && target() !== null,
    noteTurn(input) {
      if (!target()) return;
      const body = JSON.stringify({
        botId: input.botId, botName: input.botName, threadId: input.threadId, turnId: input.turn.turnId ?? `${input.threadId}:${now()}`,
        person: input.turn.person, reply: input.turn.bot, owner: input.turn.owner !== false,
        ...(input.turn.room ? { room: input.turn.room } : {}), at: now(),
      });
      if (queue.length >= MAX_QUEUED) {
        queue.shift();
        log("external memory: the service has been away too long; the oldest waiting turn was dropped");
      }
      queue.push({ body, tries: 0 });
      if (queue.length === 1 && !timer) void flush();
    },
    recall,
    recallFor: (bot, memoryId, message, autoRecall) => (autoRecall && bot.memoryEnabled !== false ? recall(memoryId, message) : Promise.resolve([])),
    corePrompt(botId) {
      const known = target() ? core.get(botId) : undefined;
      if (!known?.length) return "";
      return `\n\n## ${CORE_LABEL}\nFacts your long-term memory service keeps for every conversation. Prefer what the person says now over them.\n${known.map((line) => `- ${line}`).join("\n")}`;
    },
    async warm(botIds) {
      if (!target()) return;
      for (const botId of botIds) await recall(botId, "");
    },
    pending: () => queue.length,
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

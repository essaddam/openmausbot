import type { Config } from "./config.ts";
import type { DreamDeps, DreamReport } from "./dream.ts";
import { dreamOnce } from "./dream.ts";

const RETRY_MS = 15 * 60_000;
const MAX_BATCHES_PER_RUN = 20;

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
  /** Dreams now over every waiting turn of one bot, without waiting for quiet. */
  runNow(botId: string): Promise<DreamReport[]>;
}

export function createWorker(deps: DreamDeps, settings: Config["dream"]): Worker {
  let timer: ReturnType<typeof setInterval> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const retryAt = new Map<string, number>();

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function dueBots(): Promise<string[]> {
    const rows = await deps.db.query<{ id: string }>(
      `SELECT b.id FROM maus.bots b
       JOIN LATERAL (SELECT count(*) AS waiting, max(e.at) AS last FROM maus.episodes e WHERE e.bot_id = b.id AND e.id > b.cursor) p ON true
       WHERE p.waiting > 0 AND (p.last <= now() - make_interval(secs => $1::double precision / 1000) OR p.waiting >= $2)
       ORDER BY b.last_dream_at NULLS FIRST`,
      [settings.quietMs, settings.pendingTurns],
    );
    return rows.rows.map((row) => row.id).filter((id) => (retryAt.get(id) ?? 0) <= Date.now());
  }

  async function drain(botId: string): Promise<DreamReport[]> {
    const reports: DreamReport[] = [];
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const report = await dreamOnce(deps, botId, settings.batchChars);
      if (!report) break;
      reports.push(report);
      if (!report.episodes) break;
    }
    retryAt.delete(botId);
    return reports;
  }

  async function tick(): Promise<void> {
    if (!deps.llm) return;
    await serial(async () => {
      for (const botId of await dueBots()) {
        try {
          await drain(botId);
        } catch (error) {
          retryAt.set(botId, Date.now() + RETRY_MS);
          deps.log(`dream ${botId}: deferred 15 min: ${(error as Error).message}`);
        }
      }
    });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((error: unknown) => deps.log(`dream tick failed: ${(error as Error).message}`)), settings.tickMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await queue;
    },
    tick,
    runNow: (botId) => serial(() => drain(botId)),
  };
}

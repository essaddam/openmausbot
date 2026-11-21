import type { Queryable } from "./db.ts";
import type { Embedder } from "./embeddings.ts";
import { toPgVector } from "./embeddings.ts";
import { neighbors } from "./graph.ts";
import type { Fact } from "./store.ts";
import { currentAt, getFacts, listFacts } from "./store.ts";
import { clip, fold, terms } from "./text.ts";

export type HitReason = "text" | "vector" | "graph";

export interface SearchHit {
  fact: Fact;
  score: number;
  why: HitReason[];
  /** For a graph hit: the entity it was reached from and the relation walked. */
  path?: string;
}

export interface SearchOptions {
  embedder?: Embedder | null;
  asOf?: Date;
  limit?: number;
  log?: (message: string) => void;
}

const RRF_K = 60;
const LIST_SIZE = 30;
const MIN_SIMILARITY = 0.3;
const MIN_TERMS_FOR_TWO = 5;

const tsQuote = (term: string) => `'${term.replace(/'/g, "''").replace(/\\/g, "")}'`;

async function textRanked(db: Queryable, botId: string, words: readonly string[], asOf: Date | null): Promise<string[]> {
  if (!words.length) return [];
  const rows = await db.query<{ id: string; text: string; subject: string | null }>(
    `SELECT id, text, subject FROM maus.facts
     WHERE bot_id = $1 AND ${currentAt("coalesce($3::timestamptz, now())")} AND search @@ to_tsquery('simple', $2)
     ORDER BY ts_rank_cd(search, to_tsquery('simple', $2)) DESC LIMIT ${LIST_SIZE}`,
    [botId, words.map(tsQuote).join(" | "), asOf],
  );
  const needed = words.length >= MIN_TERMS_FOR_TWO ? 2 : 1;
  return rows.rows.filter((row) => {
    const present = new Set(terms(`${row.subject ?? ""} ${row.text}`));
    return words.filter((word) => present.has(word)).length >= needed;
  }).map((row) => row.id);
}

async function vectorRanked(db: Queryable, botId: string, query: string, embedder: Embedder, asOf: Date | null): Promise<string[]> {
  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  const rows = await db.query<{ id: string; similarity: number }>(
    `SELECT id, 1 - (embedding <=> $2::vector) AS similarity FROM maus.facts
     WHERE bot_id = $1 AND embed_model = $3 AND embedding IS NOT NULL AND ${currentAt("coalesce($4::timestamptz, now())")}
     ORDER BY embedding <=> $2::vector LIMIT ${LIST_SIZE}`,
    [botId, toPgVector(vector), embedder.model, asOf],
  );
  return rows.rows.filter((row) => row.similarity >= MIN_SIMILARITY).map((row) => row.id);
}

/** Entities named in the query, then the facts about them and, today, about their neighbours in the graph. */
async function graphRanked(db: Queryable, botId: string, query: string, asOf: Date | null): Promise<{ ids: string[]; paths: Map<string, string> }> {
  const asked = new Set(terms(query));
  const folded = fold(query);
  const entities = await db.query<{ key: string; name: string }>("SELECT key, name FROM maus.entities WHERE bot_id = $1", [botId]);
  const named = entities.rows.filter((entity) => {
    const words = terms(entity.name);
    return words.length ? words.every((word) => asked.has(word)) : folded.includes(entity.key);
  });
  if (!named.length) return { ids: [], paths: new Map() };
  const keys = named.map((entity) => entity.key);
  const direct = await db.query<{ id: string }>(
    `SELECT DISTINCT f.id, f.recorded_at FROM maus.facts f JOIN maus.fact_entities fe ON fe.fact_id = f.id
     WHERE f.bot_id = $1 AND fe.entity_key = ANY($2::text[]) AND ${currentAt("coalesce($3::timestamptz, now())")}
     ORDER BY f.recorded_at DESC LIMIT ${LIST_SIZE}`,
    [botId, keys, asOf],
  );
  const ids = direct.rows.map((row) => row.id);
  const paths = new Map<string, string>();
  if (!asOf) {
    const names = new Map(named.map((entity) => [entity.key, entity.name]));
    for (const neighbor of await neighbors(db, botId, keys)) {
      if (ids.includes(neighbor.factId)) continue;
      ids.push(neighbor.factId);
      paths.set(neighbor.factId, `${[...names.values()].join(", ")} → ${neighbor.via} → ${neighbor.name}${neighbor.hops === 2 ? " (2 sauts)" : ""}`);
    }
  }
  return { ids: ids.slice(0, LIST_SIZE), paths };
}

export async function search(db: Queryable, botId: string, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const asOf = options.asOf ?? null;
  const words = terms(query);
  const lists: { reason: HitReason; ids: string[] }[] = [{ reason: "text", ids: await textRanked(db, botId, words, asOf) }];
  if (options.embedder) {
    try {
      lists.push({ reason: "vector", ids: await vectorRanked(db, botId, query, options.embedder, asOf) });
    } catch (error) {
      options.log?.(`search: vectors skipped: ${(error as Error).message}`);
    }
  }
  const graph = await graphRanked(db, botId, query, asOf);
  lists.push({ reason: "graph", ids: graph.ids });

  const scores = new Map<string, { score: number; why: Set<HitReason> }>();
  for (const list of lists) {
    list.ids.forEach((id, rank) => {
      const entry = scores.get(id) ?? { score: 0, why: new Set<HitReason>() };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.why.add(list.reason);
      scores.set(id, entry);
    });
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, options.limit ?? 8);
  const live = new Map((await currentFacts(db, botId, ranked.map(([id]) => id), asOf)).map((fact) => [fact.id, fact]));
  return ranked.flatMap(([id, entry]) => {
    const fact = live.get(id);
    if (!fact) return [];
    const path = graph.paths.get(id);
    return [{ fact, score: entry.score, why: [...entry.why], ...(path ? { path } : {}) }];
  });
}

async function currentFacts(db: Queryable, botId: string, ids: readonly string[], asOf: Date | null): Promise<Fact[]> {
  if (!ids.length) return [];
  const live = await db.query<{ id: string }>(
    `SELECT id FROM maus.facts WHERE bot_id = $1 AND id = ANY($2::uuid[]) AND ${currentAt("coalesce($3::timestamptz, now())")}`,
    [botId, ids, asOf],
  );
  return getFacts(db, botId, live.rows.map((row) => row.id));
}

export interface RecallPassage {
  id: string;
  label: string;
  at: number;
  snippet: string;
}

export interface Recall {
  core: string[];
  passages: RecallPassage[];
}

export const RECALL_MIN_CHARS = 8;
const CORE_MAX_CHARS = 1_500;
const PASSAGES = 5;

export function describe(fact: Fact): string {
  const until = fact.validTo ? ` (jusqu'au ${fact.validTo.toISOString().slice(0, 10)})` : "";
  return `${clip(fact.text, 400)}${until}`;
}

export async function recall(db: Queryable, botId: string, message: string, options: SearchOptions = {}): Promise<Recall> {
  const core: string[] = [];
  let used = 0;
  for (const fact of await listFacts(db, botId, { core: true, limit: 40 })) {
    const line = describe(fact);
    if (used + line.length > CORE_MAX_CHARS) break;
    core.push(line);
    used += line.length;
  }
  if (message.trim().length < RECALL_MIN_CHARS) return { core, passages: [] };
  const hits = await search(db, botId, message, { ...options, limit: PASSAGES * 2 });
  const passages = hits.filter((hit) => !hit.fact.core).slice(0, PASSAGES).map((hit) => ({
    id: hit.fact.id,
    label: hit.fact.subject ?? hit.fact.kind,
    at: (hit.fact.validFrom ?? hit.fact.recordedAt).getTime(),
    snippet: hit.path ? `${describe(hit.fact)} [lien : ${hit.path}]` : describe(hit.fact),
  }));
  return { core, passages };
}

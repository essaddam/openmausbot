import type { Db, Queryable } from "./db.ts";
import { inTransaction } from "./db.ts";
import { toPgVector } from "./embeddings.ts";
import { addRelation, deleteBotGraph, deleteEntities, deleteRelations, retireRelations, upsertEntity } from "./graph.ts";
import { entityKey, mentionsWords, squash } from "./text.ts";

export const FACT_KINDS = ["preference", "fact", "decision", "rule", "event"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type FactSource = "dream" | "tool" | "api" | "import";

export interface Fact {
  id: string;
  botId: string;
  text: string;
  kind: FactKind;
  subject: string | null;
  core: boolean;
  aboutUser: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  recordedAt: Date;
  invalidatedAt: Date | null;
  supersededBy: string | null;
  source: FactSource;
  episodeIds: number[];
  evidence: string[];
  confidence: number | null;
}

export interface EntityRef {
  name: string;
  type?: string;
}

export interface RelationRef {
  from: string;
  type: string;
  to: string;
}

export interface FactInput {
  text: string;
  kind?: FactKind;
  subject?: string | null;
  core?: boolean;
  aboutUser?: boolean;
  validFrom?: Date | null;
  validTo?: Date | null;
  source: FactSource;
  episodeIds?: number[];
  evidence?: string[];
  confidence?: number | null;
  entities?: EntityRef[];
  relations?: RelationRef[];
  embedding?: { model: string; vector: number[] } | null;
}

export interface Episode {
  id: number;
  botId: string;
  threadId: string;
  turnId: string;
  person: string;
  reply: string;
  owner: boolean;
  room: unknown;
  at: Date;
}

const FACT_COLUMNS = `id, bot_id, text, kind, subject, core, about_user, valid_from, valid_to, recorded_at, invalidated_at, superseded_by, source,
  episode_ids, evidence, confidence`;

interface FactRow {
  id: string; bot_id: string; text: string; kind: FactKind; subject: string | null; core: boolean; about_user: boolean;
  valid_from: Date | null; valid_to: Date | null; recorded_at: Date; invalidated_at: Date | null; superseded_by: string | null;
  source: FactSource; episode_ids: (string | number)[]; evidence: string[]; confidence: number | null;
}

function toFact(row: FactRow): Fact {
  return {
    id: row.id, botId: row.bot_id, text: row.text, kind: row.kind, subject: row.subject, core: row.core, aboutUser: row.about_user,
    validFrom: row.valid_from, validTo: row.valid_to, recordedAt: row.recorded_at, invalidatedAt: row.invalidated_at,
    supersededBy: row.superseded_by, source: row.source, episodeIds: row.episode_ids.map(Number), evidence: row.evidence, confidence: row.confidence,
  };
}

/** True at `$n` both in the world (valid_*) and in what the memory knew then (recorded/invalidated). */
export function currentAt(param: string): string {
  return `recorded_at <= ${param} AND (invalidated_at IS NULL OR invalidated_at > ${param})
    AND (valid_from IS NULL OR valid_from <= ${param}) AND (valid_to IS NULL OR valid_to > ${param})`;
}

export async function ensureBot(db: Queryable, botId: string, name?: string): Promise<void> {
  await db.query(
    `INSERT INTO maus.bots (id, name) VALUES ($1, coalesce($2, '')) ON CONFLICT (id) DO UPDATE SET name = coalesce(nullif($2, ''), maus.bots.name)`,
    [botId, name ?? null],
  );
}

export interface EpisodeInput {
  botId: string;
  botName?: string;
  threadId: string;
  turnId: string;
  person: string;
  reply: string;
  owner: boolean;
  room?: unknown;
  at?: Date;
}

export async function addEpisode(db: Db, input: EpisodeInput): Promise<{ id: number; duplicate: boolean }> {
  await ensureBot(db, input.botId, input.botName);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO maus.episodes (bot_id, thread_id, turn_id, person, reply, owner, room, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now())) ON CONFLICT (bot_id, turn_id) DO NOTHING RETURNING id`,
    [input.botId, input.threadId, input.turnId, input.person, input.reply, input.owner, input.room === undefined ? null : JSON.stringify(input.room), input.at ?? null],
  );
  if (inserted.rows[0]) return { id: Number(inserted.rows[0].id), duplicate: false };
  const existing = await db.query<{ id: string }>("SELECT id FROM maus.episodes WHERE bot_id = $1 AND turn_id = $2", [input.botId, input.turnId]);
  return { id: Number(existing.rows[0]?.id ?? 0), duplicate: true };
}

/** The oldest unread turns after the cursor, as many as fit in `maxChars`, always at least one. */
export async function pendingEpisodes(db: Queryable, botId: string, afterId: number, maxChars: number): Promise<Episode[]> {
  const rows = await db.query<{ id: string; bot_id: string; thread_id: string; turn_id: string; person: string; reply: string; owner: boolean; room: unknown; at: Date }>(
    "SELECT id, bot_id, thread_id, turn_id, person, reply, owner, room, at FROM maus.episodes WHERE bot_id = $1 AND id > $2 ORDER BY id LIMIT 200",
    [botId, afterId],
  );
  const out: Episode[] = [];
  let size = 0;
  for (const row of rows.rows) {
    const cost = row.person.length + row.reply.length;
    if (out.length && size + cost > maxChars) break;
    out.push({ id: Number(row.id), botId: row.bot_id, threadId: row.thread_id, turnId: row.turn_id, person: row.person, reply: row.reply, owner: row.owner, room: row.room, at: row.at });
    size += cost;
  }
  return out;
}

async function linkEntities(tx: Queryable, botId: string, factId: string, entities: readonly EntityRef[], relations: readonly RelationRef[]): Promise<void> {
  const byKey = new Map<string, { key: string; name: string; type: string }>();
  for (const entity of entities) {
    const key = entityKey(entity.name);
    if (key) byKey.set(key, { key, name: squash(entity.name).slice(0, 120), type: (entity.type ?? "thing").toLowerCase().slice(0, 40) });
  }
  for (const relation of relations) {
    for (const name of [relation.from, relation.to]) {
      const key = entityKey(name);
      if (key && !byKey.has(key)) byKey.set(key, { key, name: squash(name).slice(0, 120), type: "thing" });
    }
  }
  for (const entity of byKey.values()) {
    await tx.query(
      `INSERT INTO maus.entities (bot_id, key, name, type) VALUES ($1, $2, $3, $4)
       ON CONFLICT (bot_id, key) DO UPDATE SET name = excluded.name, type = CASE WHEN excluded.type = 'thing' THEN maus.entities.type ELSE excluded.type END, updated_at = now()`,
      [botId, entity.key, entity.name, entity.type],
    );
    await tx.query("INSERT INTO maus.fact_entities (fact_id, bot_id, entity_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [factId, botId, entity.key]);
    await upsertEntity(tx, botId, entity);
  }
  for (const relation of relations) {
    const from = entityKey(relation.from);
    const to = entityKey(relation.to);
    const type = relation.type.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (from && to && type && from !== to) await addRelation(tx, botId, { from, to, type, factId });
  }
}

export async function insertFact(tx: Queryable, botId: string, input: FactInput): Promise<Fact> {
  const row = await tx.query<FactRow>(
    `INSERT INTO maus.facts (bot_id, text, kind, subject, core, about_user, valid_from, valid_to, source, episode_ids, evidence, confidence, embedding, embed_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${FACT_COLUMNS}`,
    [
      botId, squash(input.text), input.kind ?? "fact", input.subject ? squash(input.subject).slice(0, 80) : null, input.core ?? false, input.aboutUser ?? false,
      input.validFrom ?? null, input.validTo ?? null, input.source, input.episodeIds ?? [], input.evidence ?? [], input.confidence ?? null,
      input.embedding ? toPgVector(input.embedding.vector) : null, input.embedding?.model ?? null,
    ],
  );
  const fact = toFact(row.rows[0]!);
  await linkEntities(tx, botId, fact.id, input.entities ?? [], input.relations ?? []);
  return fact;
}

/** Retires a fact without losing it: it stays readable with `asOf` a time before `at`. */
export async function invalidateFact(tx: Queryable, botId: string, factId: string, change: { at?: Date; supersededBy?: string; endedInWorld?: Date | null } = {}): Promise<boolean> {
  const result = await tx.query(
    `UPDATE maus.facts SET invalidated_at = coalesce($3, now()), superseded_by = coalesce($4, superseded_by),
       valid_to = CASE WHEN $5::timestamptz IS NULL THEN valid_to ELSE least(coalesce(valid_to, $5::timestamptz), $5::timestamptz) END
     WHERE bot_id = $1 AND id = $2 AND invalidated_at IS NULL`,
    [botId, factId, change.at ?? null, change.supersededBy ?? null, change.endedInWorld ?? null],
  );
  if (!result.rowCount) return false;
  await retireRelations(tx, botId, factId);
  return true;
}

export async function replaceFact(db: Db, botId: string, factId: string, input: FactInput): Promise<Fact | null> {
  return inTransaction(db, async (tx) => {
    const old = await tx.query<FactRow>(`SELECT ${FACT_COLUMNS} FROM maus.facts WHERE bot_id = $1 AND id = $2 AND invalidated_at IS NULL FOR UPDATE`, [botId, factId]);
    const previous = old.rows[0];
    if (!previous) return null;
    const fact = await insertFact(tx, botId, { kind: previous.kind, subject: previous.subject, core: previous.core, aboutUser: previous.about_user, ...input });
    await invalidateFact(tx, botId, factId, { supersededBy: fact.id, endedInWorld: input.validFrom ?? null });
    return fact;
  });
}

export async function getFacts(db: Queryable, botId: string, ids: readonly string[]): Promise<Fact[]> {
  if (!ids.length) return [];
  const rows = await db.query<FactRow>(`SELECT ${FACT_COLUMNS} FROM maus.facts WHERE bot_id = $1 AND id = ANY($2::uuid[])`, [botId, ids]);
  return rows.rows.map(toFact);
}

export async function listFacts(db: Queryable, botId: string, options: { asOf?: Date; core?: boolean; limit?: number } = {}): Promise<Fact[]> {
  const rows = await db.query<FactRow>(
    `SELECT ${FACT_COLUMNS} FROM maus.facts WHERE bot_id = $1 AND ${currentAt("coalesce($2::timestamptz, now())")}
       AND ($3::boolean IS NULL OR core = $3) ORDER BY core DESC, recorded_at DESC LIMIT $4`,
    [botId, options.asOf ?? null, options.core ?? null, options.limit ?? 200],
  );
  return rows.rows.map(toFact);
}

export async function factHistory(db: Queryable, botId: string, factId: string): Promise<Fact[]> {
  const rows = await db.query<FactRow>(
    `WITH RECURSIVE chain AS (
       SELECT ${FACT_COLUMNS} FROM maus.facts WHERE bot_id = $1 AND id = $2
       UNION
       SELECT f.id, f.bot_id, f.text, f.kind, f.subject, f.core, f.about_user, f.valid_from, f.valid_to, f.recorded_at, f.invalidated_at, f.superseded_by,
              f.source, f.episode_ids, f.evidence, f.confidence
       FROM maus.facts f JOIN chain c ON f.superseded_by = c.id OR c.superseded_by = f.id
       WHERE f.bot_id = $1
     ) SELECT * FROM chain ORDER BY recorded_at`,
    [botId, factId],
  );
  return rows.rows.map(toFact);
}

/** Deletes outright (text, history, relations) and keeps the words so no later dream learns them again. */
export async function forget(db: Db, botId: string, target: { factId?: string; words?: string }): Promise<number> {
  return inTransaction(db, async (tx) => {
    let ids: string[] = [];
    if (target.factId) {
      const chain = await factHistory(tx, botId, target.factId);
      ids = chain.map((fact) => fact.id);
    }
    if (target.words?.trim()) {
      const all = await tx.query<{ id: string; text: string; subject: string | null }>("SELECT id, text, subject FROM maus.facts WHERE bot_id = $1", [botId]);
      ids.push(...all.rows.filter((row) => mentionsWords(`${row.subject ?? ""} ${row.text}`, target.words!)).map((row) => row.id));
      await tx.query("INSERT INTO maus.forgotten (bot_id, words) VALUES ($1, $2) ON CONFLICT DO NOTHING", [botId, squash(target.words).slice(0, 200)]);
    }
    const unique = [...new Set(ids)];
    for (const id of unique) await deleteRelations(tx, botId, id);
    if (!unique.length) return 0;
    await tx.query("UPDATE maus.facts SET superseded_by = NULL WHERE bot_id = $1 AND superseded_by = ANY($2::uuid[])", [botId, unique]);
    const deleted = await tx.query("DELETE FROM maus.facts WHERE bot_id = $1 AND id = ANY($2::uuid[])", [botId, unique]);
    const orphans = await tx.query<{ key: string }>(
      "DELETE FROM maus.entities e WHERE e.bot_id = $1 AND NOT EXISTS (SELECT 1 FROM maus.fact_entities fe WHERE fe.bot_id = e.bot_id AND fe.entity_key = e.key) RETURNING key",
      [botId],
    );
    await deleteEntities(tx, botId, orphans.rows.map((row) => row.key));
    return deleted.rowCount ?? 0;
  });
}

export async function forgottenWords(db: Queryable, botId: string): Promise<string[]> {
  return (await db.query<{ words: string }>("SELECT words FROM maus.forgotten WHERE bot_id = $1", [botId])).rows.map((row) => row.words);
}

export async function deleteBot(db: Db, botId: string): Promise<void> {
  await inTransaction(db, async (tx) => {
    await deleteBotGraph(tx, botId);
    await tx.query("DELETE FROM maus.bots WHERE id = $1", [botId]);
  });
}

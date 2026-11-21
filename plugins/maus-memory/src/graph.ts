import type { Queryable } from "./db.ts";

const GRAPH = "maus_graph";

/** AGE takes Cypher parameters only as one agtype map bound to a prepared-statement parameter. */
async function cypher<Row extends Record<string, string>>(db: Queryable, query: string, columns: readonly (keyof Row & string)[], params: Record<string, unknown>): Promise<Row[]> {
  const as = columns.map((column) => `${column} agtype`).join(", ");
  const result = await db.query<Row>(`SELECT * FROM cypher('${GRAPH}', $$ ${query} $$, $1) AS (${as})`, [JSON.stringify(params)]);
  return result.rows;
}

function scalar(value: string | undefined): unknown {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function upsertEntity(db: Queryable, botId: string, entity: { key: string; name: string; type: string }): Promise<void> {
  await cypher(db, "MERGE (e:Entity {bot_id: $bot, key: $key}) SET e.name = $name, e.type = $type RETURN e.key", ["key"], { bot: botId, ...entity });
}

export async function addRelation(db: Queryable, botId: string, relation: { from: string; to: string; type: string; factId: string }): Promise<void> {
  await cypher(db, `
    MATCH (a:Entity {bot_id: $bot, key: $from}), (b:Entity {bot_id: $bot, key: $to})
    CREATE (a)-[r:REL {bot_id: $bot, type: $type, fact_id: $fact, current: true}]->(b)
    RETURN r.type`, ["type"], { bot: botId, from: relation.from, to: relation.to, type: relation.type, fact: relation.factId });
}

/** Relations stay in the graph for history; only current ones are walked. */
export async function retireRelations(db: Queryable, botId: string, factId: string): Promise<void> {
  await cypher(db, "MATCH ()-[r:REL {bot_id: $bot, fact_id: $fact}]->() SET r.current = false RETURN r.type", ["type"], { bot: botId, fact: factId });
}

export async function deleteRelations(db: Queryable, botId: string, factId: string): Promise<void> {
  await cypher(db, "MATCH ()-[r:REL {bot_id: $bot, fact_id: $fact}]->() DELETE r RETURN 1", ["ok"], { bot: botId, fact: factId });
}

export async function deleteEntities(db: Queryable, botId: string, keys: readonly string[]): Promise<void> {
  if (keys.length) await cypher(db, "MATCH (e:Entity {bot_id: $bot}) WHERE e.key IN $keys DETACH DELETE e RETURN 1", ["ok"], { bot: botId, keys });
}

export async function deleteBotGraph(db: Queryable, botId: string): Promise<void> {
  await cypher(db, "MATCH (e:Entity {bot_id: $bot}) DETACH DELETE e RETURN 1", ["ok"], { bot: botId });
}

export interface Neighbor {
  key: string;
  name: string;
  hops: number;
  via: string;
  factId: string;
}

/** Entities reachable from the given ones over current relations, with the fact each step rests on. */
export async function neighbors(db: Queryable, botId: string, keys: readonly string[], maxHops: 1 | 2 = 2): Promise<Neighbor[]> {
  if (!keys.length) return [];
  const found: Neighbor[] = [];
  const oneHop = await cypher<{ key: string; name: string; via: string; fact: string }>(db, `
    MATCH (a:Entity {bot_id: $bot})-[r:REL {current: true}]-(b:Entity {bot_id: $bot})
    WHERE a.key IN $keys
    RETURN b.key, b.name, r.type, r.fact_id`, ["key", "name", "via", "fact"], { bot: botId, keys });
  for (const row of oneHop) found.push({ key: String(scalar(row.key)), name: String(scalar(row.name)), hops: 1, via: String(scalar(row.via)), factId: String(scalar(row.fact)) });
  if (maxHops === 2) {
    const twoHops = await cypher<{ key: string; name: string; via: string; fact: string }>(db, `
      MATCH (a:Entity {bot_id: $bot})-[:REL {current: true}]-(m:Entity {bot_id: $bot})-[r:REL {current: true}]-(b:Entity {bot_id: $bot})
      WHERE a.key IN $keys AND NOT b.key IN $keys
      RETURN b.key, b.name, r.type, r.fact_id`, ["key", "name", "via", "fact"], { bot: botId, keys });
    for (const row of twoHops) found.push({ key: String(scalar(row.key)), name: String(scalar(row.name)), hops: 2, via: String(scalar(row.via)), factId: String(scalar(row.fact)) });
  }
  const best = new Map<string, Neighbor>();
  for (const neighbor of found) {
    const id = `${neighbor.key}|${neighbor.factId}`;
    if (!best.has(id) || best.get(id)!.hops > neighbor.hops) best.set(id, neighbor);
  }
  return [...best.values()].sort((a, b) => a.hops - b.hops);
}

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.PoolClient, "query">;

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

/** Apache AGE resolves its operators through search_path; the server must preload its library (shared_preload_libraries=age). */
const SESSION_OPTIONS = `-c search_path=ag_catalog,"$user",public`;

export function openDb(databaseUrl: string, max = 5): Db {
  return new pg.Pool({ connectionString: databaseUrl, max, options: SESSION_OPTIONS });
}

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, options: SESSION_OPTIONS });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('maus-memory-migrate'))");
    await client.query("CREATE SCHEMA IF NOT EXISTS maus");
    await client.query("CREATE TABLE IF NOT EXISTS maus.migrations (id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ id: string }>("SELECT id FROM maus.migrations")).rows.map((row) => row.id));
    const applied: string[] = [];
    for (const file of readdirSync(SQL_DIR).filter((name) => name.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(SQL_DIR, file), "utf8"));
        await client.query("INSERT INTO maus.migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('maus-memory-migrate'))").catch(() => undefined);
    await client.end();
  }
}

export async function inTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

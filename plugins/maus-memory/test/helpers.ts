import { randomBytes } from "node:crypto";
import pg from "pg";
import type { Db } from "../src/db.ts";
import { migrate, openDb } from "../src/db.ts";
import type { Embedder } from "../src/embeddings.ts";
import type { Llm } from "../src/llm.ts";
import { fold } from "../src/text.ts";

/** A server with pgvector and Apache AGE, age preloaded; each test file gets its own throwaway database on it. */
const ADMIN_URL = process.env.MAUS_TEST_DATABASE_URL ?? "postgres://postgres@localhost:55432/postgres?host=/tmp";

export interface TestDb {
  db: Db;
  url: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

export async function freshDb(): Promise<TestDb> {
  const name = `maus_test_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = withDatabase(ADMIN_URL, name);
  await migrate(url);
  const db = openDb(url);
  return {
    db, url,
    async drop() {
      await db.end();
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Bag-of-words hashed into 64 dimensions: texts sharing words point the same way, which is all the tests need. */
export function fakeEmbedder(): Embedder & { calls: number } {
  const embedder = {
    model: "fake:bow-64",
    calls: 0,
    async embed(texts: readonly string[]) {
      embedder.calls += 1;
      return texts.map((text) => {
        const vector: number[] = Array.from({ length: 64 }, () => 0);
        for (const word of fold(text).match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
          let hash = 0;
          for (const char of word) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
          vector[hash % 64]! += 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((value) => value / norm);
      });
    },
  };
  return embedder;
}

export function fakeLlm(answers: (string | Error)[]): Llm & { prompts: string[] } {
  const llm = {
    name: "fake",
    prompts: [] as string[],
    async complete(_system: string, prompt: string) {
      llm.prompts.push(prompt);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? "{\"add\": [], \"invalidate\": []}";
    },
  };
  return llm;
}

export const quiet = () => undefined;

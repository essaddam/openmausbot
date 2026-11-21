import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { z } from "zod";
import type { Db } from "./db.ts";
import { inTransaction } from "./db.ts";
import type { Embedder } from "./embeddings.ts";
import type { Llm } from "./llm.ts";
import { recall, search } from "./search.ts";
import { addEpisode, deleteBot, ensureBot, factHistory, FACT_KINDS, forget, insertFact, listFacts, replaceFact } from "./store.ts";
import { looksSecret } from "./text.ts";
import type { Worker } from "./worker.ts";

export interface ApiDeps {
  db: Db;
  token: string;
  embedder: Embedder | null;
  llm: Llm | null;
  worker: Worker;
  log: (message: string) => void;
}

const MAX_BODY_BYTES = 1_000_000;
const botId = z.string().regex(/^[\w-]{1,80}$/);
const when = z.union([z.number(), z.string()]).transform((value) => new Date(value)).refine((value) => !Number.isNaN(value.getTime()), "invalid date");

const turnSchema = z.object({
  botId, botName: z.string().max(120).optional(),
  threadId: z.string().min(1).max(200), turnId: z.string().min(1).max(200),
  person: z.string().max(40_000), reply: z.string().max(40_000).default(""),
  owner: z.boolean().default(true), room: z.unknown().optional(), at: when.optional(),
});
const recallSchema = z.object({ botId, message: z.string().max(20_000) });
const searchSchema = z.object({ botId, query: z.string().min(1).max(4_000), asOf: when.optional(), limit: z.number().int().min(1).max(50).optional() });
const factSchema = z.object({
  text: z.string().min(1).max(1_000), kind: z.enum(FACT_KINDS).optional(), subject: z.string().max(80).nullish(),
  core: z.boolean().optional(), aboutUser: z.boolean().optional(), validFrom: when.nullish(), validTo: when.nullish(),
  entities: z.array(z.object({ name: z.string().min(1).max(120), type: z.string().max(40).optional() })).max(12).optional(),
  relations: z.array(z.object({ from: z.string().min(1).max(120), type: z.string().min(1).max(40), to: z.string().min(1).max(120) })).max(12).optional(),
});
const forgetSchema = z.object({ factId: z.string().uuid().optional(), words: z.string().min(2).max(200).optional() }).refine((value) => value.factId || value.words, "factId or words");
const criteriaSchema = z.object({ criteria: z.string().max(4_000).nullable() });

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return result.data;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  response.end(text);
}

export function createApi(deps: ApiDeps) {
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    if (url.pathname === "/healthz" && method === "GET") {
      await deps.db.query("SELECT 1");
      return send(response, 200, { ok: true, embeddings: deps.embedder?.model ?? null, llm: deps.llm?.name ?? null });
    }
    if (!authorized(request, deps.token)) throw new HttpError(401, "missing or wrong bearer token");

    if (url.pathname === "/v1/turns" && method === "POST") {
      const turn = parse(turnSchema, await readJson(request));
      return send(response, 200, await addEpisode(deps.db, turn));
    }
    if (url.pathname === "/v1/recall" && method === "POST") {
      const input = parse(recallSchema, await readJson(request));
      return send(response, 200, await recall(deps.db, input.botId, input.message, { embedder: deps.embedder, log: deps.log }));
    }
    if (url.pathname === "/v1/search" && method === "POST") {
      const input = parse(searchSchema, await readJson(request));
      return send(response, 200, { hits: await search(deps.db, input.botId, input.query, { embedder: deps.embedder, asOf: input.asOf, limit: input.limit, log: deps.log }) });
    }

    const bot = url.pathname.match(/^\/v1\/bots\/([\w-]{1,80})(\/.*)?$/);
    if (!bot) throw new HttpError(404, "no such route");
    const id = parse(botId, bot[1]);
    const rest = bot[2] ?? "";
    if (rest === "" && method === "DELETE") {
      await deleteBot(deps.db, id);
      return send(response, 200, { deleted: true });
    }
    if (rest === "/status" && method === "GET") {
      const row = (await deps.db.query(
        `SELECT b.name, b.cursor, b.last_dream_at, b.last_report, b.criteria,
           (SELECT count(*) FROM maus.episodes e WHERE e.bot_id = b.id AND e.id > b.cursor)::int AS waiting,
           (SELECT count(*) FROM maus.facts f WHERE f.bot_id = b.id AND f.invalidated_at IS NULL)::int AS facts
         FROM maus.bots b WHERE b.id = $1`, [id])).rows[0];
      if (!row) throw new HttpError(404, "no such bot");
      return send(response, 200, row);
    }
    if (rest === "/facts" && method === "GET") {
      const asOf = url.searchParams.get("asOf");
      const core = url.searchParams.get("core");
      return send(response, 200, { facts: await listFacts(deps.db, id, { asOf: asOf ? parse(when, asOf) : undefined, core: core === null ? undefined : core === "true" }) });
    }
    if (rest === "/facts" && method === "POST") {
      const input = parse(factSchema, await readJson(request));
      if (looksSecret(input.text)) throw new HttpError(422, "this looks like a secret and is not stored");
      await ensureBot(deps.db, id);
      const [vector] = deps.embedder ? await deps.embedder.embed([input.text]).catch(() => []) : [];
      const fact = await inTransaction(deps.db, (tx) => insertFact(tx, id, { ...input, source: "api", embedding: vector ? { model: deps.embedder!.model, vector } : null }));
      return send(response, 201, { fact });
    }
    const history = rest.match(/^\/facts\/([0-9a-f-]{36})\/history$/);
    if (history && method === "GET") return send(response, 200, { history: await factHistory(deps.db, id, history[1]!) });
    const replace = rest.match(/^\/facts\/([0-9a-f-]{36})\/replace$/);
    if (replace && method === "POST") {
      const input = parse(factSchema, await readJson(request));
      if (looksSecret(input.text)) throw new HttpError(422, "this looks like a secret and is not stored");
      const [vector] = deps.embedder ? await deps.embedder.embed([input.text]).catch(() => []) : [];
      const fact = await replaceFact(deps.db, id, replace[1]!, { ...input, source: "api", embedding: vector ? { model: deps.embedder!.model, vector } : null });
      if (!fact) throw new HttpError(404, "no current fact with that id");
      return send(response, 200, { fact });
    }
    if (rest === "/forget" && method === "POST") {
      const input = parse(forgetSchema, await readJson(request));
      return send(response, 200, { forgotten: await forget(deps.db, id, input) });
    }
    if (rest === "/dream" && method === "POST") {
      if (!deps.llm) throw new HttpError(409, "no model is configured (MAUS_LLM)");
      return send(response, 200, { reports: await deps.worker.runNow(id) });
    }
    if (rest === "/criteria" && method === "PUT") {
      const input = parse(criteriaSchema, await readJson(request));
      await ensureBot(deps.db, id);
      await deps.db.query("UPDATE maus.bots SET criteria = $2 WHERE id = $1", [id, input.criteria?.trim() || null]);
      return send(response, 200, { criteria: input.criteria?.trim() || null });
    }
    throw new HttpError(404, "no such route");
  }

  return createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) deps.log(`http ${request.method} ${request.url?.split("?")[0]}: ${(error as Error).message}`);
      if (!response.headersSent) send(response, status, { error: status === 500 ? "internal error" : (error as Error).message });
      else response.end();
    });
  });
}

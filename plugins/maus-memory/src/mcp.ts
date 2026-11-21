#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Db } from "./db.ts";
import { inTransaction, openDb } from "./db.ts";
import type { Embedder } from "./embeddings.ts";
import { createEmbedder } from "./embeddings.ts";
import { neighbors } from "./graph.ts";
import { describe, search } from "./search.ts";
import type { Fact } from "./store.ts";
import { ensureBot, factHistory, FACT_KINDS, forget, insertFact, listFacts, replaceFact } from "./store.ts";
import { entityKey, looksSecret } from "./text.ts";
import { loadConfig } from "./config.ts";

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (text: string, isError = false): Reply => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

const date = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "?");
function line(fact: Fact): string {
  const span = fact.validFrom || fact.validTo ? ` · valable ${date(fact.validFrom)} → ${fact.validTo ? date(fact.validTo) : "…"}` : "";
  const retired = fact.invalidatedAt ? ` · remplacé le ${date(fact.invalidatedAt)}` : "";
  return `- [${fact.id}] (${fact.kind}${fact.core ? ", noyau" : ""}${fact.subject ? `, ${fact.subject}` : ""}) ${describe(fact)} · noté le ${date(fact.recordedAt)}${span}${retired}`;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD").transform((value) => new Date(`${value.slice(0, 10)}T00:00:00Z`));

export function createMemoryMcp(db: Db, botId: string, embedder: Embedder | null): McpServer {
  const server = new McpServer({ name: "maus-memory", version: "0.1.0" });
  const embed = async (text: string) => {
    if (!embedder) return null;
    const [vector] = await embedder.embed([text]).catch(() => []);
    return vector ? { model: embedder.model, vector } : null;
  };

  server.registerTool("memory_search", {
    description: "Search this bot's long-term memory (full text, meaning and the knowledge graph). Use asOf (YYYY-MM-DD) to see what was true on a past day.",
    inputSchema: { query: z.string().min(1).max(2_000), asOf: isoDate.optional(), limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ query, asOf, limit }) => {
    const hits = await search(db, botId, query, { embedder, asOf, limit: limit ?? 10 });
    if (!hits.length) return reply("Rien de pertinent en mémoire.");
    return reply(hits.map((hit) => `${line(hit.fact)} · trouvé par ${hit.why.join("+")}${hit.path ? ` · ${hit.path}` : ""}`).join("\n"));
  });

  server.registerTool("memory_list", {
    description: "List what this bot currently remembers (or remembered on asOf), core facts first.",
    inputSchema: { core: z.boolean().optional(), asOf: isoDate.optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ core, asOf, limit }) => {
    const facts = await listFacts(db, botId, { core, asOf, limit: limit ?? 50 });
    return reply(facts.length ? facts.map(line).join("\n") : "La mémoire est vide.");
  });

  server.registerTool("memory_add", {
    description: "Save one lasting fact the person told you or asked you to remember. One self-contained sentence. Never secrets.",
    inputSchema: {
      text: z.string().min(1).max(600), kind: z.enum(FACT_KINDS).optional(), subject: z.string().max(80).optional(),
      core: z.boolean().optional().describe("True only for something needed in nearly every conversation."),
      validFrom: isoDate.optional(), validTo: isoDate.optional(),
      entities: z.array(z.object({ name: z.string().min(1).max(120), type: z.string().max(40).optional() })).max(8).optional(),
      relations: z.array(z.object({ from: z.string().min(1), type: z.string().min(1).max(40), to: z.string().min(1) })).max(6).optional(),
    },
  }, async (input) => {
    if (looksSecret(input.text)) return reply("Refusé : ce texte ressemble à un secret (mot de passe, clé, jeton).", true);
    await ensureBot(db, botId);
    const embedding = await embed(input.text);
    const fact = await inTransaction(db, (tx) => insertFact(tx, botId, { ...input, aboutUser: true, source: "tool", embedding }));
    return reply(`Enregistré : ${line(fact)}`);
  });

  server.registerTool("memory_update", {
    description: "Replace a remembered fact that changed. The old version stays in the history, no longer current.",
    inputSchema: { id: z.string().uuid(), text: z.string().min(1).max(600), validFrom: isoDate.optional() },
  }, async ({ id, text, validFrom }) => {
    if (looksSecret(text)) return reply("Refusé : ce texte ressemble à un secret.", true);
    const fact = await replaceFact(db, botId, id, { text, validFrom, source: "tool", embedding: await embed(text) });
    return fact ? reply(`Mis à jour : ${line(fact)}`) : reply("Aucun fait actuel avec cet identifiant.", true);
  });

  server.registerTool("memory_forget", {
    description: "Erase facts for good when the person asks to forget: by id, or every fact that mentions all of the given words. They will not be learned again.",
    inputSchema: { id: z.string().uuid().optional(), words: z.string().min(2).max(200).optional() },
    annotations: { destructiveHint: true },
  }, async ({ id, words }) => {
    if (!id && !words) return reply("Donne un identifiant ou des mots.", true);
    const count = await forget(db, botId, { factId: id, words });
    return reply(count ? `${count} fait(s) oublié(s).` : "Rien à oublier.");
  });

  server.registerTool("memory_history", {
    description: "Show how one fact changed over time, oldest first.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const chain = await factHistory(db, botId, id);
    return reply(chain.length ? chain.map(line).join("\n") : "Inconnu.");
  });

  server.registerTool("memory_graph", {
    description: "Walk the knowledge graph around a person, client, machine or project: what it is linked to and through which fact.",
    inputSchema: { entity: z.string().min(1).max(120), depth: z.union([z.literal(1), z.literal(2)]).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ entity, depth }) => {
    const found = await neighbors(db, botId, [entityKey(entity)], depth ?? 1);
    if (!found.length) return reply(`Aucun lien connu pour « ${entity} ».`);
    return reply(found.map((n) => `- ${entity} —${n.via}→ ${n.name}${n.hops === 2 ? " (2 sauts)" : ""} [fait ${n.factId}]`).join("\n"));
  });

  return server;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const botId = process.env.MAUS_MEMORY_BOT_ID ?? "";
  if (!/^[\w-]{1,80}$/.test(botId)) {
    console.error("maus-memory-mcp: set MAUS_MEMORY_BOT_ID to the bot's id (letters, digits, _ or -).");
    process.exit(1);
  }
  const config = loadConfig({ ...process.env, MAUS_MEMORY_TOKEN: process.env.MAUS_MEMORY_TOKEN ?? "x".repeat(16), MAUS_LLM: "none" });
  const db = openDb(config.databaseUrl, 2);
  const server = createMemoryMcp(db, botId, createEmbedder(config.embeddings));
  await server.connect(new StdioServerTransport());
  process.on("SIGTERM", () => void db.end().finally(() => process.exit(0)));
}

#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { migrate, openDb } from "./db.ts";
import { createEmbedder } from "./embeddings.ts";
import { createApi } from "./http.ts";
import { createLlm } from "./llm.ts";
import { createWorker } from "./worker.ts";

const log = (message: string) => console.log(`[maus-memory] ${message}`);

const config = loadConfig();
const applied = await migrate(config.databaseUrl);
if (applied.length) log(`migrations applied: ${applied.join(", ")}`);

const db = openDb(config.databaseUrl);
const embedder = createEmbedder(config.embeddings);
const llm = createLlm(config.llm);
const worker = createWorker({ db, llm, embedder, log }, config.dream);
const server = createApi({ db, token: config.token, embedder, llm, worker, log });

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} — embeddings: ${embedder?.model ?? "off"}, dream model: ${llm?.name ?? "off"}`);
  worker.start();
});

async function shutdown(signal: string): Promise<void> {
  log(`${signal}: stopping`);
  server.close();
  await worker.stop();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

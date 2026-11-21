import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApi } from "../src/http.ts";
import { createMemoryMcp } from "../src/mcp.ts";
import { createWorker } from "../src/worker.ts";
import type { TestDb } from "./helpers.ts";
import { fakeEmbedder, fakeLlm, freshDb, quiet } from "./helpers.ts";

const TOKEN = "test-token-0123456789";
let t: TestDb;
let base = "";
let close: () => Promise<void>;
const llm = fakeLlm([]);

before(async () => {
  t = await freshDb();
  const embedder = fakeEmbedder();
  const worker = createWorker({ db: t.db, llm, embedder, log: quiet }, { quietMs: 0, pendingTurns: 10, batchChars: 12_000, tickMs: 60_000 });
  const server = createApi({ db: t.db, token: TOKEN, embedder, llm, worker, log: quiet });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});
after(async () => {
  await close();
  await t.drop();
});

const call = (path: string, body?: unknown, token = TOKEN) => fetch(`${base}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("health answers without a token, everything else needs it", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await call("/v1/recall", { botId: "scout", message: "hello there" }, "wrong-token-0000000000")).status, 401);
  assert.equal((await fetch(`${base}/v1/recall`, { method: "POST", body: "{}" })).status, 401);
});

test("bad input is refused with the field named", async () => {
  const response = await call("/v1/turns", { botId: "../etc", threadId: "t", turnId: "u", person: "x" });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /botId/);
});

test("turns in, dream, then recall gives the core and the relevant fact", async () => {
  for (const [i, person] of ["Appelle-moi Nicky, et sois bref.", "Le NAS de la maison est un Synology DS920+."].entries()) {
    const response = await call("/v1/turns", { botId: "scout", botName: "Scout", threadId: "th", turnId: `u${i}`, person, reply: "Ok", at: Date.now() });
    assert.equal(response.status, 200);
  }
  assert.equal(((await (await call("/v1/bots/scout/status")).json()) as { waiting: number }).waiting, 2);
  llm.prompts.length = 0;
  const answers = [JSON.stringify({ add: [
    { text: "Il s'appelle Nicky et veut des réponses brèves", core: true, aboutUser: true, kind: "preference", episodes: [1], evidence: ["Appelle-moi Nicky, et sois bref"], confidence: 0.9 },
    { text: "Le NAS de la maison est un Synology DS920+", subject: "NAS", episodes: [2], evidence: ["Le NAS de la maison est un Synology DS920+"], confidence: 0.9, entities: [{ name: "Synology DS920+", type: "device" }] },
  ] })];
  llm.complete = async (_system, prompt) => { llm.prompts.push(prompt); return answers.shift() ?? "{}"; };
  const dream = await (await call("/v1/bots/scout/dream", {})).json() as { reports: { added: number }[] };
  assert.equal(dream.reports[0]?.added, 2);
  const recalled = await (await call("/v1/recall", { botId: "scout", message: "c'est quoi déjà le modèle du NAS ?" })).json() as { core: string[]; passages: { label: string; snippet: string }[] };
  assert.deepEqual(recalled.core, ["Il s'appelle Nicky et veut des réponses brèves"]);
  assert.equal(recalled.passages[0]?.label, "NAS");
  assert.match(recalled.passages[0]!.snippet, /DS920\+/);
});

test("a secret cannot be stored through the API", async () => {
  const response = await call("/v1/bots/scout/facts", { text: "le token: ghp_abcdefghijklmnopqrstuvwxyz0123" });
  assert.equal(response.status, 422);
});

test("forget through the API", async () => {
  const response = await call("/v1/bots/scout/forget", { words: "Synology" });
  assert.deepEqual(await response.json(), { forgotten: 1 });
});

test("the MCP tools work against the same memory, for one bot only", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMemoryMcp(t.db, "scout", null);
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ["memory_add", "memory_forget", "memory_graph", "memory_history", "memory_list", "memory_search", "memory_update"]);
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as { text: string }[])[0]!.text;

  const added = text(await client.callTool({ name: "memory_add", arguments: {
    text: "Le hEX PoE du bureau tourne sous RouterOS v7", subject: "MikroTik",
    entities: [{ name: "hEX PoE", type: "device" }, { name: "RouterOS v7", type: "software" }], relations: [{ from: "hEX PoE", type: "RUNS", to: "RouterOS v7" }],
  } }));
  const id = added.match(/\[([0-9a-f-]{36})\]/)![1]!;
  assert.match(text(await client.callTool({ name: "memory_search", arguments: { query: "routeros du hex" } })), /RouterOS v7/);
  assert.match(text(await client.callTool({ name: "memory_graph", arguments: { entity: "hEX PoE" } })), /RUNS→ RouterOS v7/);
  assert.match(text(await client.callTool({ name: "memory_update", arguments: { id, text: "Le hEX PoE du bureau tourne sous RouterOS v7.20" } })), /v7\.20/);
  assert.equal(text(await client.callTool({ name: "memory_history", arguments: { id } })).split("\n").length, 2);
  const refused = await client.callTool({ name: "memory_add", arguments: { text: "api_key: sk-abcdefghijklmnopqrstuvwxyz" } });
  assert.equal(refused.isError, true);

  const [otherClient, otherServer] = InMemoryTransport.createLinkedPair();
  await createMemoryMcp(t.db, "iris", null).connect(otherServer);
  const iris = new Client({ name: "test", version: "1" });
  await iris.connect(otherClient);
  assert.equal(text(await iris.callTool({ name: "memory_search", arguments: { query: "routeros hex" } })), "Rien de pertinent en mémoire.");
  await client.close();
  await iris.close();
});

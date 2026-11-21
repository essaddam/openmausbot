import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { migrate } from "../src/db.ts";
import { neighbors } from "../src/graph.ts";
import { addEpisode, deleteBot, ensureBot, factHistory, forget, forgottenWords, insertFact, listFacts, pendingEpisodes, replaceFact } from "../src/store.ts";
import type { TestDb } from "./helpers.ts";
import { freshDb } from "./helpers.ts";

let t: TestDb;
before(async () => { t = await freshDb(); });
after(async () => { await t.drop(); });

test("migrations run once and again without change", async () => {
  assert.deepEqual(await migrate(t.url), []);
});

test("a turn sent twice is stored once, and batches respect the size budget", async () => {
  const first = await addEpisode(t.db, { botId: "scout", botName: "Scout", threadId: "th1", turnId: "turn-1", person: "a".repeat(600), reply: "ok", owner: true });
  const again = await addEpisode(t.db, { botId: "scout", threadId: "th1", turnId: "turn-1", person: "different", reply: "", owner: true });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  await addEpisode(t.db, { botId: "scout", threadId: "th1", turnId: "turn-2", person: "b".repeat(600), reply: "", owner: true });
  assert.equal((await pendingEpisodes(t.db, "scout", 0, 1_000)).length, 1);
  assert.equal((await pendingEpisodes(t.db, "scout", 0, 10)).length, 1, "always at least one turn");
  assert.equal((await pendingEpisodes(t.db, "scout", 0, 5_000)).length, 2);
  const name = await t.db.query("SELECT name FROM maus.bots WHERE id = 'scout'");
  assert.equal(name.rows[0].name, "Scout");
});

test("a replaced fact stays readable in the past and only the new one is current", async () => {
  await ensureBot(t.db, "iris");
  const office = await insertFact(t.db, "iris", { text: "Nicky travaille au bureau de Saint-Nazaire", source: "tool", subject: "travail" });
  const before = new Date();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const moved = await replaceFact(t.db, "iris", office.id, { text: "Nicky travaille depuis Pornichet", source: "tool", validFrom: new Date() });
  assert.ok(moved);
  assert.deepEqual((await listFacts(t.db, "iris")).map((fact) => fact.text), ["Nicky travaille depuis Pornichet"]);
  assert.deepEqual((await listFacts(t.db, "iris", { asOf: before })).map((fact) => fact.text), ["Nicky travaille au bureau de Saint-Nazaire"]);
  const history = await factHistory(t.db, "iris", moved!.id);
  assert.deepEqual(history.map((fact) => fact.text), ["Nicky travaille au bureau de Saint-Nazaire", "Nicky travaille depuis Pornichet"]);
  assert.equal(history[0]!.supersededBy, moved!.id);
  assert.equal(history[0]!.subject, "travail", "the replacement keeps the old subject unless given one");
  assert.equal(await replaceFact(t.db, "iris", office.id, { text: "again", source: "tool" }), null, "a retired fact cannot be replaced twice");
});

test("relations go into the AGE graph and retire with their fact", async () => {
  await ensureBot(t.db, "graph");
  const fact = await insertFact(t.db, "graph", {
    text: "Celfy est client de DGI-SYSTEM et utilise Exchange Server SE", source: "tool",
    entities: [{ name: "Celfy", type: "organisation" }, { name: "DGI-SYSTEM", type: "organisation" }, { name: "Exchange Server SE", type: "software" }],
    relations: [{ from: "Celfy", type: "client of", to: "DGI-SYSTEM" }, { from: "Celfy", type: "USES", to: "Exchange Server SE" }],
  });
  const around = await neighbors(t.db, "graph", ["dgi-system"]);
  assert.deepEqual(around.map((n) => [n.name, n.hops, n.via]).sort(), [["Celfy", 1, "CLIENT_OF"], ["Exchange Server SE", 2, "USES"]]);
  assert.ok(around.every((n) => n.factId === fact.id));
  assert.deepEqual(await neighbors(t.db, "other-bot", ["dgi-system"]), [], "another bot never walks this graph");
  await replaceFact(t.db, "graph", fact.id, { text: "Celfy n'est plus client", source: "tool" });
  assert.deepEqual(await neighbors(t.db, "graph", ["dgi-system"]), []);
});

test("forgetting erases facts, their history, entities and graph nodes, and remembers the words", async () => {
  await ensureBot(t.db, "forget");
  const first = await insertFact(t.db, "forget", { text: "Stéphanie aime le jazz", source: "tool", entities: [{ name: "Stéphanie", type: "person" }], relations: [{ from: "Stéphanie", type: "LIKES", to: "jazz" }] });
  await replaceFact(t.db, "forget", first.id, { text: "Stéphanie aime le jazz et la soul", source: "tool" });
  await insertFact(t.db, "forget", { text: "Le VPS tourne chez Contabo", source: "tool" });
  assert.equal(await forget(t.db, "forget", { words: "stéphanie" }), 2);
  assert.deepEqual((await listFacts(t.db, "forget")).map((fact) => fact.text), ["Le VPS tourne chez Contabo"]);
  const left = await t.db.query("SELECT count(*)::int AS n FROM maus.facts WHERE bot_id = 'forget' AND text ILIKE '%stéphanie%'");
  assert.equal(left.rows[0].n, 0, "no retired copy is left behind");
  const vertices = await t.db.query(`SELECT * FROM cypher('maus_graph', $$ MATCH (e:Entity {bot_id: 'forget'}) RETURN e.name $$) AS (name agtype)`);
  assert.equal(vertices.rowCount, 0);
  assert.deepEqual(await forgottenWords(t.db, "forget"), ["stéphanie"]);
});

test("deleting a bot removes its rows and graph only", async () => {
  await ensureBot(t.db, "gone");
  await insertFact(t.db, "gone", { text: "A uses B", source: "tool", relations: [{ from: "A", type: "USES", to: "B" }] });
  await ensureBot(t.db, "stays");
  await insertFact(t.db, "stays", { text: "A uses B", source: "tool", relations: [{ from: "A", type: "USES", to: "B" }] });
  await deleteBot(t.db, "gone");
  assert.equal((await listFacts(t.db, "gone")).length, 0);
  assert.equal((await neighbors(t.db, "gone", ["a"])).length, 0);
  assert.equal((await neighbors(t.db, "stays", ["a"])).length, 1);
});

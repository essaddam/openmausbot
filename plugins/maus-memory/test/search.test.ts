import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { recall, search } from "../src/search.ts";
import { ensureBot, insertFact, replaceFact } from "../src/store.ts";
import type { TestDb } from "./helpers.ts";
import { fakeEmbedder, freshDb } from "./helpers.ts";

let t: TestDb;
const embedder = fakeEmbedder();
const embed = async (text: string) => ({ model: embedder.model, vector: (await embedder.embed([text]))[0]! });

before(async () => {
  t = await freshDb();
  await ensureBot(t.db, "ops");
  await insertFact(t.db, "ops", { text: "Nicky veut des réponses courtes, en français", source: "tool", kind: "preference", core: true, embedding: await embed("Nicky veut des réponses courtes, en français") });
  await insertFact(t.db, "ops", {
    text: "Celfy utilise Exchange Server SE en local", source: "tool", subject: "Celfy",
    entities: [{ name: "Celfy", type: "organisation" }, { name: "Exchange Server SE", type: "software" }],
    relations: [{ from: "Celfy", type: "USES", to: "Exchange Server SE" }], embedding: await embed("Celfy utilise Exchange Server SE en local"),
  });
  await insertFact(t.db, "ops", {
    text: "Christophe valide les accès externes de Celfy", source: "tool", subject: "Celfy",
    entities: [{ name: "Christophe", type: "person" }, { name: "Celfy", type: "organisation" }],
    relations: [{ from: "Christophe", type: "APPROVES_FOR", to: "Celfy" }],
  });
  await insertFact(t.db, "ops", { text: "Le routeur hEX PoE du bureau fait du VRRP avec la Freebox en secours", source: "tool", subject: "MikroTik", embedding: await embed("Le routeur hEX PoE du bureau fait du VRRP avec la Freebox en secours") });
  await ensureBot(t.db, "perso");
  await insertFact(t.db, "perso", { text: "Celfy est un mot que ce bot ne doit jamais voir chez ops", source: "tool" });
});
after(async () => { await t.drop(); });

test("full text finds a fact by its words, accents ignored", async () => {
  const hits = await search(t.db, "ops", "le vrrp du hex poe");
  assert.equal(hits[0]?.fact.subject, "MikroTik");
  assert.ok(hits[0]!.why.includes("text"));
});

test("the graph reaches facts two steps away from a named entity, with the path", async () => {
  const hits = await search(t.db, "ops", "qui s'occupe d'Exchange Server SE ?");
  const christophe = hits.find((hit) => hit.fact.text.startsWith("Christophe"));
  assert.ok(christophe, "found through Exchange Server SE → Celfy → Christophe");
  assert.ok(christophe!.why.includes("graph"));
  assert.match(christophe!.path ?? "", /APPROVES_FOR/);
});

test("vectors rank a fact by closeness of meaning", async () => {
  const hits = await search(t.db, "ops", "secours freebox routeur bureau", { embedder });
  assert.ok(hits.some((hit) => hit.why.includes("vector") && hit.fact.subject === "MikroTik"));
});

test("one bot never sees another bot's facts", async () => {
  const hits = await search(t.db, "perso", "Exchange Server SE Celfy");
  assert.ok(hits.every((hit) => hit.fact.botId === "perso"));
});

test("asOf shows what was true then", async () => {
  await ensureBot(t.db, "time");
  const old = await insertFact(t.db, "time", { text: "Le VPS principal est chez OVH", source: "tool" });
  const then = new Date();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await replaceFact(t.db, "time", old.id, { text: "Le VPS principal est chez Contabo", source: "tool" });
  assert.deepEqual((await search(t.db, "time", "VPS principal")).map((hit) => hit.fact.text), ["Le VPS principal est chez Contabo"]);
  assert.deepEqual((await search(t.db, "time", "VPS principal", { asOf: then })).map((hit) => hit.fact.text), ["Le VPS principal est chez OVH"]);
});

test("recall always carries core facts and adds only relevant others", async () => {
  const short = await recall(t.db, "ops", "salut");
  assert.deepEqual(short, { core: ["Nicky veut des réponses courtes, en français"], passages: [] });
  const about = await recall(t.db, "ops", "Rappelle-moi comment est configuré le VRRP du hEX PoE");
  assert.equal(about.core.length, 1);
  assert.equal(about.passages[0]?.label, "MikroTik");
  assert.ok(about.passages.every((passage) => !passage.snippet.includes("réponses courtes")), "core facts are not repeated as passages");
});

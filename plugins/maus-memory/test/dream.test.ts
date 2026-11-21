import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dreamOnce, dreamPrompt } from "../src/dream.ts";
import { neighbors } from "../src/graph.ts";
import { addEpisode, factHistory, forget, insertFact, listFacts } from "../src/store.ts";
import { createWorker } from "../src/worker.ts";
import type { TestDb } from "./helpers.ts";
import { fakeEmbedder, fakeLlm, freshDb, quiet } from "./helpers.ts";

let t: TestDb;
let bot = "";
let turn = 0;
before(async () => { t = await freshDb(); });
after(async () => { await t.drop(); });

function dreamTest(name: string, body: () => Promise<void> | void) {
  test(name, async () => {
    bot = `bot${Math.random().toString(36).slice(2, 8)}`;
    await body();
  });
}

const say = (person: string, owner = true) => addEpisode(t.db, { botId: bot, botName: "Scout", threadId: "th", turnId: `t${++turn}`, person, reply: "Noté.", owner });
const cursor = async () => Number((await t.db.query("SELECT cursor FROM maus.bots WHERE id = $1", [bot])).rows[0].cursor);
const lastTurn = async () => Number((await t.db.query("SELECT max(id) AS id FROM maus.episodes WHERE bot_id = $1", [bot])).rows[0].id);

dreamTest("supported facts are kept with their entities, made-up or unsupported ones are not", async () => {
  await say("Je bosse chez DGI-SYSTEM, et à partir de maintenant réponds-moi toujours en français.");
  await say("Le client Celfy est sur Exchange Server SE, leur prestataire veut un accès Graph.");
  const llm = fakeLlm([JSON.stringify({
    add: [
      { text: "Nicky travaille chez DGI-SYSTEM", kind: "fact", core: true, aboutUser: true, episodes: [1], evidence: ["Je bosse chez DGI-SYSTEM"], confidence: 0.95,
        entities: [{ name: "Nicky", type: "person" }, { name: "DGI-SYSTEM", type: "organisation" }], relations: [{ from: "Nicky", type: "WORKS_AT", to: "DGI-SYSTEM" }] },
      { text: "Nicky veut des réponses en français", kind: "rule", core: true, aboutUser: true, episodes: [1], evidence: ["à partir de maintenant réponds-moi toujours en français"], confidence: 0.9 },
      { text: "Celfy utilise Exchange Server SE", kind: "fact", subject: "Celfy", episodes: [2], evidence: ["Le client Celfy est sur Exchange Server SE"], confidence: 0.9,
        entities: [{ name: "Celfy", type: "organisation" }, { name: "Exchange Server SE", type: "software" }, { name: "Microsoft", type: "organisation" }],
        relations: [{ from: "Celfy", type: "USES", to: "Exchange Server SE" }, { from: "Celfy", type: "BUYS_FROM", to: "Microsoft" }] },
      { text: "Nicky déteste PowerShell", episodes: [1], evidence: ["je déteste PowerShell"], confidence: 0.9 },
      { text: "Celfy a 45 boîtes aux lettres", episodes: [2], evidence: ["Le client Celfy est sur Exchange Server SE"], confidence: 0.9 },
      { text: "Le mot de passe admin: P4ssw0rd!2026", episodes: [2], evidence: ["Le client Celfy"], confidence: 0.9 },
      { text: "Celfy migrera vers M365", episodes: [2], evidence: ["Le client Celfy est sur Exchange Server SE"], confidence: 0.3 },
    ],
    invalidate: [],
  })]);
  const report = await dreamOnce({ db: t.db, llm, embedder: fakeEmbedder(), log: quiet }, bot, 12_000);
  assert.equal(report?.added, 3);
  assert.deepEqual(report?.skipped.map((s) => s.reason), ["quote not found in E1", "a number, path or URL is not in the quotes", "looks like a secret", "low confidence"]);
  assert.deepEqual((await listFacts(t.db, bot, { core: true })).map((fact) => fact.text).sort(), ["Nicky travaille chez DGI-SYSTEM", "Nicky veut des réponses en français"]);
  const celfy = await neighbors(t.db, bot, ["celfy"], 1);
  assert.deepEqual(celfy.map((n) => n.name), ["Exchange Server SE"], "an entity the person never named is dropped with its relation");
  assert.equal(await cursor(), await lastTurn());
  assert.ok(llm.prompts[0]!.includes("E2"));
});

dreamTest("a change of fact retires the old one and links it to its replacement", async () => {
  await say("Mon VPS principal est chez OVH.");
  await dreamOnce({ db: t.db, llm: fakeLlm([JSON.stringify({ add: [{ text: "Le VPS principal de Nicky est chez OVH", episodes: [1], evidence: ["Mon VPS principal est chez OVH"], confidence: 0.9 }] })]), embedder: null, log: quiet }, bot, 12_000);
  await say("J'ai migré, le VPS principal est maintenant chez Contabo depuis le 2026-11-01.");
  const llm = fakeLlm([JSON.stringify({
    add: [{ text: "Le VPS principal de Nicky est chez Contabo depuis le 2026-11-01", validFrom: "2026-11-01", episodes: [1], evidence: ["le VPS principal est maintenant chez Contabo depuis le 2026-11-01"], confidence: 0.9 }],
    invalidate: [{ fact: "F1", episodes: [1], evidence: ["J'ai migré"], replacedBy: 0 }],
  })]);
  const report = await dreamOnce({ db: t.db, llm, embedder: null, log: quiet }, bot, 12_000);
  assert.equal(report?.invalidated, 1);
  const now = await listFacts(t.db, bot);
  assert.deepEqual(now.map((fact) => fact.text), ["Le VPS principal de Nicky est chez Contabo depuis le 2026-11-01"]);
  const history = await factHistory(t.db, bot, now[0]!.id);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.validTo?.toISOString().slice(0, 10), "2026-11-01", "the old fact ends when the new one starts");
  assert.ok(llm.prompts[0]!.includes("F1 [fact] Le VPS principal de Nicky est chez OVH"));
});

dreamTest("a retirement without the person's words is refused", async () => {
  await say("On parle d'autre chose.");
  await insertFact(t.db, bot, { text: "Nicky utilise Pi comme harnais", source: "tool" });
  const report = await dreamOnce({ db: t.db, llm: fakeLlm([JSON.stringify({ invalidate: [{ fact: "F1", episodes: [1], evidence: ["Pi ne me sert plus"] }] })]), embedder: null, log: quiet }, bot, 12_000);
  assert.equal(report?.invalidated, 0);
  assert.equal((await listFacts(t.db, bot)).length, 1);
});

dreamTest("in a group chat only the person's own lines count, and nothing about them comes from others", async () => {
  await say("Geoffrey gère le domaine enfant pour les mairies.", false);
  const report = await dreamOnce({ db: t.db, llm: fakeLlm([JSON.stringify({ add: [{ text: "Geoffrey gère le domaine enfant pour les mairies", aboutUser: true, core: true, episodes: [1], evidence: ["Geoffrey gère le domaine enfant pour les mairies"], confidence: 0.9 }] })]), embedder: null, log: quiet }, bot, 12_000);
  assert.equal(report?.added, 1);
  const [fact] = await listFacts(t.db, bot);
  assert.equal(fact!.aboutUser, false);
  assert.equal(fact!.core, false);
});

dreamTest("forgotten words are not learned again", async () => {
  await say("Stéphanie adore le jazz.");
  await insertFact(t.db, bot, { text: "placeholder", source: "tool" });
  await forget(t.db, bot, { words: "Stéphanie" });
  const report = await dreamOnce({ db: t.db, llm: fakeLlm([JSON.stringify({ add: [{ text: "Stéphanie adore le jazz", episodes: [1], evidence: ["Stéphanie adore le jazz"], confidence: 0.9 }] })]), embedder: null, log: quiet }, bot, 12_000);
  assert.deepEqual(report?.skipped.map((s) => s.reason), ["the Person asked to forget it"]);
});

dreamTest("a failed model call keeps the turns for the next dream", async () => {
  await say("Je teste une panne.");
  await assert.rejects(dreamOnce({ db: t.db, llm: fakeLlm([new Error("HTTP 529")]), embedder: null, log: quiet }, bot, 12_000), /529/);
  assert.equal(await cursor(), 0);
  const report = await dreamOnce({ db: t.db, llm: fakeLlm([]), embedder: null, log: quiet }, bot, 12_000);
  assert.equal(report?.episodes, 1);
  assert.equal(await cursor(), await lastTurn());
});

dreamTest("without a model nothing is read and nothing moves", async () => {
  await say("Personne pour rêver.");
  const report = await dreamOnce({ db: t.db, llm: null, embedder: null, log: quiet }, bot, 12_000);
  assert.equal(report?.episodes, 0);
  assert.equal(await cursor(), 0);
});

dreamTest("the worker waits for quiet, then drains every batch", async () => {
  for (let i = 0; i < 3; i++) await say(`message ${"x".repeat(900)} ${i}`);
  const llm = fakeLlm([]);
  const waiting = createWorker({ db: t.db, llm, embedder: null, log: quiet }, { quietMs: 60 * 60_000, pendingTurns: 50, batchChars: 1_000, tickMs: 60_000 });
  await waiting.tick();
  assert.equal(llm.prompts.length, 0, "still inside the quiet time");
  const ready = createWorker({ db: t.db, llm, embedder: null, log: quiet }, { quietMs: 0, pendingTurns: 50, batchChars: 1_000, tickMs: 60_000 });
  await ready.tick();
  assert.ok(llm.prompts.length >= 3, "one batch per turn at this size");
  assert.equal(await cursor(), await lastTurn());
});

dreamTest("the prompt marks group chats and lists kept facts with their dates", () => {
  const prompt = dreamPrompt({
    botName: "Scout", today: new Date("2026-11-21T10:00:00Z"), criteria: "keep X",
    episodes: [{ id: 9, botId: "b", threadId: "t", turnId: "u", person: "hello", reply: "hi", owner: false, room: null, at: new Date("2026-11-20T08:00:00Z") }],
    facts: [{ id: "f", botId: "b", text: "A fact", kind: "rule", subject: "x", core: true, aboutUser: false, validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, recordedAt: new Date(), invalidatedAt: null, supersededBy: null, source: "tool", episodeIds: [], evidence: [], confidence: null }],
  });
  assert.match(prompt, /E1 \(2026-11-20, group chat/);
  assert.match(prompt, /F1 \[rule, core, x, from 2026-01-01\] A fact/);
  assert.match(prompt, /What to keep: keep X/);
});

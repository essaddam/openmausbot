import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createEmbedder } from "../src/embeddings.ts";
import { createLlm, jsonObject } from "../src/llm.ts";

const seen: { path: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
let base = "";
const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ path: request.url ?? "", headers: request.headers, body });
    const answers: Record<string, unknown> = {
      "/api/embed": { embeddings: body.input?.map((_: string, i: number) => [i, 1]) },
      "/v1/embeddings": { data: body.input?.map((_: string, i: number) => ({ index: body.input.length - 1 - i, embedding: [body.input.length - 1 - i, 2] })).reverse() },
      "/v1/messages": { content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "{\"add\": []}" }] },
      "/v1/chat/completions": { choices: [{ message: { content: "Voici : ```json\n{\"add\": [], \"invalidate\": []}\n```" } }] },
    };
    const answer = answers[request.url ?? ""];
    response.writeHead(answer ? 200 : 500, { "content-type": "application/json" }).end(JSON.stringify(answer ?? {}));
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("Ollama embeddings send the model and every text in one call", async () => {
  const embedder = createEmbedder({ provider: "ollama", url: base, model: "bge-m3" })!;
  assert.equal(embedder.model, "ollama:bge-m3");
  assert.deepEqual(await embedder.embed(["a", "b"]), [[0, 1], [1, 1]]);
  assert.deepEqual(seen.at(-1)?.body, { model: "bge-m3", input: ["a", "b"] });
});

test("OpenAI-compatible embeddings come back in input order whatever order the provider uses", async () => {
  const embedder = createEmbedder({ provider: "openai", url: `${base}/v1`, model: "text-embedding-3-small", apiKey: "k" })!;
  assert.deepEqual(await embedder.embed(["a", "b", "c"]), [[0, 2], [1, 2], [2, 2]]);
  assert.equal(seen.at(-1)?.headers.authorization, "Bearer k");
});

test("an Anthropic-compatible endpoint gets the Messages API and only text blocks come back", async () => {
  const llm = createLlm({ provider: "anthropic", url: base, model: "glm-4.6", apiKey: "secret" })!;
  assert.equal(await llm.complete("system", "prompt"), "{\"add\": []}");
  const call = seen.at(-1)!;
  assert.equal(call.path, "/v1/messages");
  assert.equal(call.headers["x-api-key"], "secret");
  assert.equal(call.body.system, "system");
  assert.deepEqual(call.body.messages, [{ role: "user", content: "prompt" }]);
});

test("an OpenAI-compatible endpoint gets chat completions, and the JSON is found inside prose", async () => {
  const llm = createLlm({ provider: "openai", url: `${base}/v1`, model: "kimi-k2" })!;
  const answer = await llm.complete("system", "prompt");
  assert.deepEqual(jsonObject(answer), { add: [], invalidate: [] });
  assert.deepEqual(seen.at(-1)?.body.messages, [{ role: "system", content: "system" }, { role: "user", content: "prompt" }]);
});

test("a provider error is reported with its status and host, never its key", async () => {
  const llm = createLlm({ provider: "openai", url: `${base}/broken`, model: "m", apiKey: "do-not-print" })!;
  await assert.rejects(llm.complete("s", "p"), (error: Error) => /HTTP 500/.test(error.message) && !error.message.includes("do-not-print"));
});

test("configuration comes from the environment with safe defaults", () => {
  const config = loadConfig({ MAUS_DATABASE_URL: "postgres://x", MAUS_MEMORY_TOKEN: "0123456789abcdef", MAUS_EMBEDDINGS: "ollama", MAUS_LLM: "claude-cli" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.deepEqual(config.embeddings, { provider: "ollama", url: "http://127.0.0.1:11434", model: "bge-m3" });
  assert.deepEqual(config.llm, { provider: "claude-cli", command: "claude", model: "haiku" });
  assert.equal(config.dream.quietMs, 600_000);
  assert.throws(() => loadConfig({ MAUS_DATABASE_URL: "postgres://x", MAUS_MEMORY_TOKEN: "short" }));
});

test("jsonObject ignores braces inside strings and rejects broken JSON", () => {
  assert.deepEqual(jsonObject("x {\"a\": \"}{\"} y"), { a: "}{" });
  assert.equal(jsonObject("{\"a\": "), null);
  assert.equal(jsonObject("no json"), null);
});

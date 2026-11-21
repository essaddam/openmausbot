import { afterEach, describe, expect, it, vi } from "vitest";

import { createExternalMemory, externalMemoryUrlAllowed, resolveExternalMemoryConfig, type ExternalMemoryConfig } from "./external-memory.ts";
import { buildRecall } from "./recall.ts";

const turn = { person: "Le NAS de la maison est un Synology", bot: "Noté.", turnId: "turn-1", owner: true };

function fakeService(answers: (Response | Error)[]) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")), auth: new Headers(init?.headers).get("authorization") });
    const next = answers.shift() ?? new Response("{}", { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe("external memory config", () => {
  it("reads the file, and the environment wins", () => {
    expect(resolveExternalMemoryConfig(undefined, {})).toBeNull();
    expect(resolveExternalMemoryConfig({ url: "http://127.0.0.1:8787", token: "file" }, {})).toEqual({ url: "http://127.0.0.1:8787", token: "file" });
    expect(resolveExternalMemoryConfig({ url: "http://127.0.0.1:8787", token: "file", recallTimeoutMs: 900 }, { OMB_EXTERNAL_MEMORY_URL: "https://memory.example.com", OMB_EXTERNAL_MEMORY_TOKEN: "env" }))
      .toEqual({ url: "https://memory.example.com", token: "env", recallTimeoutMs: 900 });
  });

  it("sends the person's words only over https or inside a private network", () => {
    expect(externalMemoryUrlAllowed("http://127.0.0.1:8787")).toBe(true);
    expect(externalMemoryUrlAllowed("http://192.168.1.20:8787")).toBe(true);
    expect(externalMemoryUrlAllowed("http://vm.tail1234.ts.net:8787")).toBe(true);
    expect(externalMemoryUrlAllowed("https://memory.example.com")).toBe(true);
    expect(externalMemoryUrlAllowed("http://memory.example.com")).toBe(false);
    expect(externalMemoryUrlAllowed("https://user:pass@memory.example.com")).toBe(false);
  });

  it("is off for a refused address and for a bot whose memory is off", () => {
    const log = vi.fn();
    const refused = createExternalMemory({ config: () => ({ url: "http://memory.example.com" }), log, fetch: fakeService([]).fetch });
    expect(refused.enabledFor({})).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    refused.enabledFor({});
    expect(log).toHaveBeenCalledTimes(1);
    const on = createExternalMemory({ config: () => ({ url: "http://127.0.0.1:8787" }), fetch: fakeService([]).fetch });
    expect(on.enabledFor({ memoryEnabled: false })).toBe(false);
    expect(on.enabledFor({})).toBe(true);
  });
});

describe("turns", () => {
  const config: ExternalMemoryConfig = { url: "http://127.0.0.1:8787/", token: "secret-token" };

  it("posts each captured turn with the token", async () => {
    const service = fakeService([]);
    const memory = createExternalMemory({ config: () => config, fetch: service.fetch, now: () => 1_700_000_000_000 });
    memory.noteTurn({ botId: "scout", botName: "Scout", threadId: "th1", turn });
    await settle();
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toEqual({
      url: "http://127.0.0.1:8787/v1/turns", auth: "Bearer secret-token",
      body: { botId: "scout", botName: "Scout", threadId: "th1", turnId: "turn-1", person: turn.person, reply: "Noté.", owner: true, at: 1_700_000_000_000 },
    });
    expect(memory.pending()).toBe(0);
  });

  it("keeps turns while the service is away and sends them in order once it is back", async () => {
    vi.useFakeTimers();
    const service = fakeService([new Error("ECONNREFUSED"), json({ id: 1 }), json({ id: 2 })]);
    const log = vi.fn();
    const memory = createExternalMemory({ config: () => config, fetch: service.fetch, log });
    memory.noteTurn({ botId: "scout", botName: "Scout", threadId: "th1", turn });
    await vi.advanceTimersByTimeAsync(0);
    memory.noteTurn({ botId: "scout", botName: "Scout", threadId: "th1", turn: { ...turn, turnId: "turn-2" } });
    expect(memory.pending()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(memory.pending()).toBe(0);
    expect(service.calls.map((call) => (call.body as { turnId: string }).turnId)).toEqual(["turn-1", "turn-1", "turn-2"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("waiting for the service"));
  });

  it("drops a turn the service refuses instead of retrying it forever", async () => {
    const service = fakeService([json({ error: "botId" }, 400)]);
    const memory = createExternalMemory({ config: () => config, fetch: service.fetch, log: () => undefined });
    memory.noteTurn({ botId: "scout", botName: "Scout", threadId: "th1", turn });
    await settle();
    expect(memory.pending()).toBe(0);
  });
});

describe("recall", () => {
  const config: ExternalMemoryConfig = { url: "http://127.0.0.1:8787", token: "t" };

  it("turns the service's passages into recall passages and keeps its core facts for the prompt", async () => {
    const service = fakeService([json({ core: ["Il s'appelle Nicky", 42], passages: [{ label: "NAS", at: 1_700_000_000_000, snippet: "Le NAS est un Synology DS920+" }, { snippet: "" }] })]);
    const memory = createExternalMemory({ config: () => config, fetch: service.fetch });
    expect(memory.corePrompt("scout")).toBe("");
    const passages = await memory.recall("scout", "c'est quoi le NAS déjà ?");
    expect(passages).toEqual([{ source: "memory", label: "long-term memory · NAS", at: 1_700_000_000_000, snippet: "Le NAS est un Synology DS920+" }]);
    expect(memory.corePrompt("scout")).toContain("- Il s'appelle Nicky");
    expect(memory.corePrompt("iris")).toBe("");
  });

  it("never holds a turn up: a slow or failing service gives no passages", async () => {
    const memory = createExternalMemory({ config: () => ({ ...config, recallTimeoutMs: 100 }), fetch: fakeService([new Error("The operation was aborted due to timeout")]).fetch, log: () => undefined });
    expect(await memory.recall("scout", "anything at all")).toEqual([]);
    const down = createExternalMemory({ config: () => config, fetch: fakeService([json({}, 503)]).fetch, log: () => undefined });
    expect(await down.recall("scout", "anything at all")).toEqual([]);
  });

  it("puts long-term passages first in the recall block", () => {
    const result = buildRecall({
      botId: "bot-external-recall", message: "quel modèle de NAS à la maison", threadIds: [], label: () => "", author: () => "",
      extra: [{ source: "memory", label: "long-term memory · NAS", at: Date.UTC(2026, 10, 20), snippet: "Le NAS est un Synology DS920+" }],
    });
    expect(result?.text).toContain("[1] long-term memory · NAS (2026-11-20): Le NAS est un Synology DS920+");
    expect(result?.notes).toBe(1);
  });
});

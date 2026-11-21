// A stand-in for plugins/maus-memory answers here; the plugin's own tests run against Postgres in its folder.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";

const TOKEN = "e2e-memory-token-0123456789";

async function body(request: IncomingMessage): Promise<any> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

it("sends finished turns to the long-term memory service and brings its recall and core facts into the next turns", async () => {
  const turns: any[] = [];
  const recalls: any[] = [];
  const service = createServer((request, response) => {
    void body(request).then((payload) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.url === "/v1/turns") turns.push(payload);
      if (request.url === "/v1/recall") recalls.push(payload);
      const answer = request.url === "/v1/recall"
        ? { core: ["Il s'appelle Nicky et veut des réponses brèves"], passages: payload.message.includes("NAS") ? [{ label: "NAS", at: Date.UTC(2026, 10, 20), snippet: "Le NAS de la maison est un Synology DS920+" }] : [] }
        : { id: turns.length, duplicate: false };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const memoryUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const scratch = mkdtempSync(join(tmpdir(), "omb-external-memory-"));
  const prompts = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_PROMPTS: prompts, OMB_EXTERNAL_MEMORY_URL: memoryUrl, OMB_EXTERNAL_MEMORY_TOKEN: TOKEN });
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async <T = any>(path: string, method = "GET", payload?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const turn = async (botId: string, threadId: string, text: string) => {
    await control("send", "--bot", botId, "--task", threadId, "--text", text);
    expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
  };
  const sentCount = () => { try { return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const sentSince = (count: number) => readFileSync(prompts, "utf8").trim().split("\n").slice(count).join("\n");
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Mémo" }, 201);

    await turn(bot.id, bot.threadId, "Pour info, le NAS de la maison est un Synology DS920+.");
    await expect.poll(() => turns.length, { timeout: 10_000 }).toBe(1);
    expect(turns[0]).toMatchObject({ botId: bot.id, botName: "Mémo", threadId: bot.threadId, person: "Pour info, le NAS de la maison est un Synology DS920+.", owner: true });
    expect(typeof turns[0].reply).toBe("string");
    expect(turns[0].turnId).toBeTruthy();

    const before = sentCount();
    await turn(bot.id, bot.threadId, "C'est quoi déjà le modèle du NAS ?");
    expect(recalls.at(-1)).toEqual({ botId: bot.id, message: "C'est quoi déjà le modèle du NAS ?" });
    expect(sentSince(before)).toContain("long-term memory · NAS (2026-11-20): Le NAS de la maison est un Synology DS920+");
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.systemPrompt).toContain("- Il s'appelle Nicky et veut des réponses brèves");
    expect(JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`))).toContain("Il s'appelle Nicky et veut des réponses brèves");

    const refused = await api<{ error: string }>("/api/config", "PUT", { memory: { external: { url: "https://elsewhere.example.com" } } }, 403);
    expect(refused.error).toContain("config.json");

    await api(`/api/bots/${bot.id}`, "PATCH", { memoryEnabled: false });
    const sent = turns.length, asked = recalls.length, quietBefore = sentCount();
    await turn(bot.id, bot.threadId, "Et le NAS, il a combien de baies ?");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(turns.length).toBe(sent);
    expect(recalls.length).toBe(asked);
    expect(sentSince(quietBefore)).not.toContain("long-term memory");
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt).not.toContain("Il s'appelle Nicky");
  } finally {
    await fixture.close();
    await new Promise((resolve) => service.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

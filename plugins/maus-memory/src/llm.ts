import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmConfig } from "./config.ts";

export interface Llm {
  name: string;
  complete(system: string, prompt: string, signal?: AbortSignal): Promise<string>;
}

const TIMEOUT_MS = 180_000;
const MAX_TOKENS = 4_000;

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`llm: HTTP ${response.status} from ${new URL(url).host}`);
  return response.json();
}

function anthropic(config: Extract<LlmConfig, { provider: "anthropic" }>): Llm {
  return {
    name: `anthropic:${config.model}`,
    async complete(system, prompt, signal) {
      const base = config.url.endsWith("/") ? config.url : `${config.url}/`;
      const answer = (await postJson(new URL("v1/messages", base).toString(), {
        model: config.model, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: prompt }],
      }, { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }, signal)) as { content?: { type?: string; text?: string }[] };
      return (answer.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    },
  };
}

function openai(config: Extract<LlmConfig, { provider: "openai" }>): Llm {
  return {
    name: `openai:${config.model}`,
    async complete(system, prompt, signal) {
      const base = config.url.endsWith("/") ? config.url : `${config.url}/`;
      const answer = (await postJson(new URL("chat/completions", base).toString(), {
        model: config.model, max_tokens: MAX_TOKENS, temperature: 0,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      }, config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, signal)) as { choices?: { message?: { content?: string } }[] };
      return answer.choices?.[0]?.message?.content ?? "";
    },
  };
}

/** Claude CLI 2.1.x: the same isolation OpenMausBot's own background calls use (no tools, MCP, hooks, settings or saved session), each flag only where this CLI lists it. */
function claudeCli(config: Extract<LlmConfig, { provider: "claude-cli" }>): Llm {
  let help: string | undefined;
  const supports = (flag: string) => {
    help ??= spawnSync(config.command, ["--help"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "";
    return help.includes(flag);
  };
  return {
    name: `claude-cli:${config.model}`,
    complete(system, prompt, signal) {
      const args = ["-p", "--model", config.model, "--output-format", "text", "--settings", JSON.stringify({ alwaysThinkingEnabled: false, disableAllHooks: true })];
      if (supports("--tools")) args.push("--tools", "");
      if (supports("--no-session-persistence")) args.push("--no-session-persistence");
      if (supports("--strict-mcp-config")) args.push("--strict-mcp-config");
      if (supports("--setting-sources")) args.push("--setting-sources", "project");
      if (supports("--system-prompt")) args.push("--system-prompt", system);
      const input = supports("--system-prompt") ? prompt : `${system}\n\n${prompt}`;
      const cwd = mkdtempSync(join(tmpdir(), "maus-memory-llm-"));
      return new Promise((resolve, reject) => {
        const child = spawn(config.command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const stop = () => child.kill("SIGTERM");
        const timer = setTimeout(stop, TIMEOUT_MS);
        signal?.addEventListener("abort", stop, { once: true });
        child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
        child.on("error", (error) => { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); reject(error); });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          rmSync(cwd, { recursive: true, force: true });
          if (code === 0) resolve(out);
          else reject(new Error(`llm: claude exited ${code}: ${err.trim().slice(0, 300)}`));
        });
        child.stdin.end(input);
      });
    },
  };
}

export function createLlm(config: LlmConfig): Llm | null {
  if (config.provider === "anthropic") return anthropic(config);
  if (config.provider === "openai") return openai(config);
  if (config.provider === "claude-cli") return claudeCli(config);
  return null;
}

/** The first balanced JSON object in a model's answer, which may wrap it in prose or a code fence. */
export function jsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

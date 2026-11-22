import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProviderConfig } from "./config.ts";
import { AGENT_CLI_PRESETS } from "./llm/providers/agent-cli.ts";

type Env = Record<string, string | undefined>;

/**
 * Small models for light jobs, per agent CLI. Model names change and differ
 * by plan, so these were each checked against the real CLI (2026-11-21);
 * anyone can change one with `ojs providers add … --light-model`.
 * - claude: an alias the CLI keeps pointing at the current Haiku.
 * - codex: GPT-6 Luna, the small model for ChatGPT sign-in.
 * - agy: Gemini 3.8 Flash at low thinking, the lightest it lists (`agy models`).
 * opencode names models per provider (provider/model), so it has no default.
 */
const LIGHT_MODELS: Record<string, string> = {
  claude: "haiku",
  codex: "gpt-6-luna",
  agy: "gemini-3.8-flash-low",
};

/** Find an executable on PATH, like `which`. Works on Bun and Node. */
export function which(command: string, env: Env = process.env): string | undefined {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

export interface DetectedProvider {
  id: string;
  config: ProviderConfig;
  reason: string;
}

/**
 * Providers we can configure with zero questions: agent CLIs found on PATH,
 * and API keys found in the environment. Nothing is called or sent.
 */
export function detectProviders(env: Env = process.env): DetectedProvider[] {
  const found: DetectedProvider[] = [];
  for (const [preset, def] of Object.entries(AGENT_CLI_PRESETS)) {
    const path = which(def.command, env);
    if (path) {
      found.push({
        id: `${preset}-cli`,
        config: { type: "agent-cli", preset, timeoutMs: 300_000, ...(LIGHT_MODELS[preset] ? { lightModel: LIGHT_MODELS[preset] } : {}) },
        reason: `found ${path}${def.verified ? "" : " (preset not yet verified)"}`,
      });
    }
  }
  if (env.ANTHROPIC_API_KEY) {
    found.push({
      id: "anthropic",
      config: { type: "anthropic", model: "claude-opus-5-5", lightModel: "claude-haiku-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
      reason: "ANTHROPIC_API_KEY is set",
    });
  }
  if (env.DEEPSEEK_API_KEY) {
    found.push({
      id: "deepseek",
      config: {
        type: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        jsonMode: true,
      },
      reason: "DEEPSEEK_API_KEY is set",
    });
  }
  return found;
}

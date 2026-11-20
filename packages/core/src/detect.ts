import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProviderConfig } from "./config.ts";
import { AGENT_CLI_PRESETS } from "./llm/providers/agent-cli.ts";

type Env = Record<string, string | undefined>;

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
        config: { type: "agent-cli", preset, timeoutMs: 300_000 },
        reason: `found ${path}${def.verified ? "" : " (preset not yet verified)"}`,
      });
    }
  }
  if (env.ANTHROPIC_API_KEY) {
    found.push({
      id: "anthropic",
      config: { type: "anthropic", model: "claude-opus-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
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

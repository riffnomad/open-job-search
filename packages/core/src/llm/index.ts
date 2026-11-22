import type { Config, ProviderConfig } from "../config.ts";
import { AgentCliProvider } from "./providers/agent-cli.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { type LLMProvider, ProviderError } from "./types.ts";

export { AGENT_CLI_PRESETS } from "./providers/agent-cli.ts";
export { extractJson, generateObject } from "./structured.ts";
export * from "./types.ts";

type Env = Record<string, string | undefined>;

function apiKey(id: string, envName: string | undefined, env: Env): string | undefined {
  if (!envName) return undefined;
  const value = env[envName];
  if (!value) throw new ProviderError(id, `environment variable ${envName} is not set`);
  return value;
}

export function createProvider(id: string, cfg: ProviderConfig, env: Env = process.env): LLMProvider {
  switch (cfg.type) {
    case "anthropic":
      return new AnthropicProvider({ id, model: cfg.model, apiKey: apiKey(id, cfg.apiKeyEnv, env), effort: cfg.effort });
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        id,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: apiKey(id, cfg.apiKeyEnv, env),
        jsonMode: cfg.jsonMode,
      });
    case "agent-cli":
      return new AgentCliProvider({ id, ...cfg });
  }
}

/**
 * Resolve a provider by name, or the configured default. With `light`, use
 * its lightModel when it has one: for light, frequent jobs like judging job
 * titles, where a small model does as well and costs far less.
 */
export function resolveProvider(config: Config, name?: string, env: Env = process.env, opts: { light?: boolean } = {}): LLMProvider {
  const id = name ?? config.defaultProvider;
  if (!id) throw new ProviderError("config", "no provider given and no defaultProvider set. Run `ojs init`.");
  const cfg = config.providers[id];
  if (!cfg) {
    const known = Object.keys(config.providers);
    throw new ProviderError("config", `no provider named "${id}". Configured: ${known.join(", ") || "none"}`);
  }
  if (opts.light && cfg.lightModel) return createProvider(`${id} (${cfg.lightModel})`, { ...cfg, model: cfg.lightModel } as ProviderConfig, env);
  return createProvider(id, cfg, env);
}

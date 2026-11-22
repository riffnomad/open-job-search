import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { configPath } from "./paths.ts";

/**
 * Secrets are never stored in config. API-based providers name the
 * environment variable that holds their key (`apiKeyEnv`), so the config
 * file is safe to show, copy and share when asking for help.
 */
const AnthropicProvider = z.object({
  type: z.literal("anthropic"),
  model: z.string().default("claude-opus-5-5"),
  apiKeyEnv: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** A smaller, cheaper model for light, frequent jobs (judging job titles). Left out: the main model does them. */
  lightModel: z.string().optional(),
});

const OpenAICompatibleProvider = z.object({
  type: z.literal("openai-compatible"),
  baseUrl: z.url(),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  /** Ask for `response_format: {type: "json_object"}` on structured calls. Most servers support it. */
  jsonMode: z.boolean().default(true),
  /** A smaller, cheaper model for light, frequent jobs (judging job titles). Left out: the main model does them. */
  lightModel: z.string().optional(),
});

const AgentCliProvider = z.object({
  type: z.literal("agent-cli"),
  /** A built-in preset (claude, codex, agy, opencode) or "custom". */
  preset: z.string(),
  /** For custom commands, or to override a preset. `{prompt}` in args is replaced with the prompt; otherwise it goes to stdin. */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().default(300_000),
  /** A smaller, cheaper model for light, frequent jobs (judging job titles). Left out: the main model does them. */
  lightModel: z.string().optional(),
});

export const ProviderConfig = z.discriminatedUnion("type", [
  AnthropicProvider,
  OpenAICompatibleProvider,
  AgentCliProvider,
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const Config = z.object({
  version: z.literal(1).default(1),
  defaultProvider: z.string().optional(),
  providers: z.record(z.string(), ProviderConfig).default({}),
});
export type Config = z.infer<typeof Config>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export async function loadConfig(path = configPath()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return Config.parse({});
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const parsed = Config.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(Config.parse(config), null, 2)}\n`, { mode: 0o600 });
}

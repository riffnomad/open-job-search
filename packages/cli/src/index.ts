#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  AGENT_CLI_PRESETS,
  ConfigError,
  ExtractError,
  configPath,
  dataRoot,
  documentsRoot,
  PersonError,
  detectProviders,
  loadConfig,
  ProfileError,
  ProfileFileError,
  ProfileLoadError,
  ProviderConfig,
  ProviderError,
  FlowError,
  UndoError,
  resolveProvider,
  saveConfig,
  which,
} from "@ojs/core";
import pkg from "../package.json" with { type: "json" };
import { FLOW_HELP, flowCommand } from "./flow.ts";
import { PEOPLE_HELP, personCommand, searchCommand, workingOnSummary } from "./people.ts";
import { PRIVACY_HELP, privacyCommand } from "./privacy.ts";
import { PROFILE_HELP, profileCommand } from "./profile.ts";

const HELP = `ojs: open-job-search

Usage: ojs <command> [options]

Commands:
  init                     Detect installed agent CLIs and API keys, and write a config
  providers                List configured providers and known agent CLIs
  providers add <id>       Add or replace a provider (see options below)
  providers default <id>   Set the default provider
  ask <prompt>             Send a prompt to a provider (handy for testing a setup)
  person                   Who we're working on; add or switch people (see below)
  search                   Their job searches: what they're looking for (see below)
  flow                     Where you are in the steps, and what's next (see below)
  profile                  Their profile: roles, past lives, details (see below)
  doctor                   Check your setup
  help                     Show this help

${PEOPLE_HELP}
${FLOW_HELP}
${PROFILE_HELP}
${PRIVACY_HELP}
Global options:
  --json                   Machine-readable output (for scripts and AI agents)
  --provider <id>          Use this provider instead of the default
  --person <name>          Work on this person, for this command only
  --search <name>          Work on this search, for this command only
  -v, --version            Print the version

providers add options:
  --type <t>               anthropic | openai-compatible | agent-cli
  --model <m>              Model name
  --base-url <url>         For openai-compatible (e.g. https://api.deepseek.com/v1)
  --api-key-env <NAME>     Env var holding the API key (keys are never stored in config)
  --preset <p>             For agent-cli: ${Object.keys(AGENT_CLI_PRESETS).join(", ")}, or custom
  --command <cmd>          For a custom agent-cli

Documents go in ${documentsRoot()}/<person>/, and what ojs builds goes in ${dataRoot()}/<person>/.
Both are ignored by git. Override the location with OJS_ROOT.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    provider: { type: "string" },
    person: { type: "string" },
    search: { type: "string" },
    role: { type: "string", multiple: true },
    staged: { type: "boolean", default: false },
    message: { type: "string" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
    type: { type: "string" },
    model: { type: "string" },
    "base-url": { type: "string" },
    "api-key-env": { type: "string" },
    preset: { type: "string" },
    command: { type: "string" },
    employer: { type: "string" },
    title: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    location: { type: "string" },
    industry: { type: "string" },
    field: { type: "string" },
    "front-matter": { type: "string" },
    section: { type: "string" },
    sub: { type: "string" },
    as: { type: "string" },
    find: { type: "string" },
    replace: { type: "string" },
    remove: { type: "boolean", default: false },
    limit: { type: "string" },
    to: { type: "string" },
    source: { type: "string" },
    text: { type: "string", multiple: true },
    "dry-run": { type: "boolean", default: false },
    paste: { type: "boolean", default: false },
    extracted: { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
  },
});

// --person / --search apply to this command only; paths.ts reads them from the environment.
if (values.person) process.env.OJS_PERSON = values.person;
if (values.search) process.env.OJS_SEARCH = values.search;

const PERSON_COMMANDS = new Set(["flow", "profile", "search"]);

function out(human: string, data: unknown): void {
  if (!values.json) return void console.log(human);
  // Every command about a person says whose data it acted on, so an agent can't lose track.
  const who = PERSON_COMMANDS.has(positionals[0] ?? "") && data && typeof data === "object" && !Array.isArray(data) ? workingOnSummary() : undefined;
  console.log(JSON.stringify(who ? { workingOn: who, ...(data as object) } : data, null, 2));
}

async function init(): Promise<void> {
  const config = await loadConfig();
  const detected = detectProviders();
  const added: string[] = [];
  for (const d of detected) {
    if (!config.providers[d.id]) {
      config.providers[d.id] = d.config;
      added.push(d.id);
    }
  }
  if (!config.defaultProvider && detected[0]) config.defaultProvider = detected[0].id;
  await saveConfig(config);

  const lines = [
    `Config: ${configPath()}`,
    "",
    detected.length ? "Detected:" : "No agent CLIs or API keys detected.",
    ...detected.map((d) => `  ${d.id.padEnd(16)} ${d.reason}${added.includes(d.id) ? "  (added)" : ""}`),
    "",
    config.defaultProvider ? `Default provider: ${config.defaultProvider}` : "No default provider yet.",
    "",
    "Next: `ojs ask \"Say hello\"` to test it, or `ojs providers add` to add another.",
  ];
  out(lines.join("\n"), { configPath: configPath(), detected, added, defaultProvider: config.defaultProvider ?? null });
}

async function providers(sub: string | undefined, id: string | undefined): Promise<void> {
  const config = await loadConfig();

  if (sub === "default") {
    if (!id || !config.providers[id]) throw new ConfigError(`usage: ojs providers default <id>  (configured: ${Object.keys(config.providers).join(", ") || "none"})`);
    config.defaultProvider = id;
    await saveConfig(config);
    return out(`Default provider: ${id}`, { defaultProvider: id });
  }

  if (sub === "add") {
    if (!id) throw new ConfigError("usage: ojs providers add <id> --type <type> [options]");
    const parsed = ProviderConfig.safeParse({
      type: values.type,
      model: values.model,
      baseUrl: values["base-url"],
      apiKeyEnv: values["api-key-env"],
      preset: values.preset ?? (values.command ? "custom" : undefined),
      command: values.command,
    });
    if (!parsed.success) throw new ConfigError(`invalid provider: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    config.providers[id] = parsed.data;
    config.defaultProvider ??= id;
    await saveConfig(config);
    return out(`Saved provider "${id}".`, { id, config: parsed.data });
  }

  if (sub) throw new ConfigError(`unknown subcommand "providers ${sub}"`);

  const configured = Object.entries(config.providers).map(([pid, cfg]) => ({
    id: pid,
    type: cfg.type,
    detail: cfg.type === "agent-cli" ? cfg.preset : cfg.model,
    default: pid === config.defaultProvider,
  }));
  const clis = Object.entries(AGENT_CLI_PRESETS).map(([name, p]) => ({
    preset: name,
    installed: Boolean(which(p.command)),
    verified: p.verified,
  }));
  const human = [
    "Configured providers:",
    ...(configured.length
      ? configured.map((c) => `  ${c.default ? "*" : " "} ${c.id.padEnd(16)} ${c.type.padEnd(18)} ${c.detail}`)
      : ["  none. Run `ojs init`."]),
    "",
    "Agent CLIs:",
    ...clis.map((c) => `    ${c.preset.padEnd(16)} ${c.installed ? "installed" : "not found"}${c.verified ? "" : "  (unverified preset)"}`),
  ].join("\n");
  out(human, { configured, agentClis: clis });
}

async function ask(prompt: string | undefined): Promise<void> {
  if (!prompt) throw new ConfigError('usage: ojs ask "<prompt>"');
  const provider = resolveProvider(await loadConfig(), values.provider);
  const started = performance.now();
  const text = await provider.generateText({ prompt });
  const ms = Math.round(performance.now() - started);
  out(text, { provider: provider.id, ms, text });
}

async function doctor(): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    const config = await loadConfig();
    checks.push({ name: "config", ok: true, detail: configPath() });
    const ids = Object.keys(config.providers);
    checks.push({ name: "providers", ok: ids.length > 0, detail: ids.join(", ") || "none configured; run `ojs init`" });
    if (config.defaultProvider) {
      try {
        resolveProvider(config);
        checks.push({ name: "default provider", ok: true, detail: config.defaultProvider });
      } catch (e) {
        checks.push({ name: "default provider", ok: false, detail: (e as Error).message });
      }
    } else {
      checks.push({ name: "default provider", ok: false, detail: "not set" });
    }
  } catch (e) {
    checks.push({ name: "config", ok: false, detail: (e as Error).message });
  }
  out(checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name.padEnd(18)} ${c.detail}`).join("\n"), { ok: checks.every((c) => c.ok), checks });
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (values.version) return out(pkg.version, { version: pkg.version });
  const [cmd, ...rest] = positionals;
  switch (cmd) {
    case undefined:
    case "help":
      return void console.log(HELP);
    case "init":
      return init();
    case "providers":
      return providers(rest[0], rest[1]);
    case "ask":
      return ask(rest.join(" ") || undefined);
    case "person":
      return personCommand(rest, out);
    case "search":
      return searchCommand(rest, values, out);
    case "flow":
      return flowCommand(rest, out);
    case "profile":
      return profileCommand(rest, values, out);
    case "privacy":
      return privacyCommand(rest, values, out);
    case "doctor":
      return doctor();
    default:
      throw new ConfigError(`unknown command "${cmd}". Run \`ojs help\`.`);
  }
}

main().catch((err: unknown) => {
  const known = [ConfigError, ProviderError, ProfileError, ProfileFileError, ProfileLoadError, ExtractError, UndoError, FlowError, PersonError].some((E) => err instanceof E);
  const message = known ? (err as Error).message : String((err as Error)?.stack ?? err);
  if (values.json) console.log(JSON.stringify({ error: message }));
  else console.error(`ojs: ${message}`);
  process.exitCode = 1;
});

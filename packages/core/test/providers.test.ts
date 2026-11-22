import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, ConfigError, createProvider, loadConfig, ProviderError, resolveProvider, saveConfig } from "../src/index.ts";
import { OpenAICompatibleProvider } from "../src/llm/providers/openai-compatible.ts";

describe("agent-cli provider", () => {
  test("sends the prompt on stdin and returns stdout (custom command)", async () => {
    const p = createProvider("echo", { type: "agent-cli", preset: "custom", command: "cat", timeoutMs: 5000 });
    expect(await p.generateText({ system: "SYS", prompt: "hello" })).toBe("SYS\n\n---\n\nhello");
  });

  test("substitutes {prompt} into args", async () => {
    const p = createProvider("echo", {
      type: "agent-cli",
      preset: "custom",
      command: "echo",
      args: ["{prompt}"],
      timeoutMs: 5000,
    });
    expect(await p.generateText({ prompt: "hi there" })).toBe("hi there");
  });

  test("reports a missing command clearly", async () => {
    const p = createProvider("ghost", {
      type: "agent-cli",
      preset: "custom",
      command: "ojs-definitely-not-installed",
      timeoutMs: 5000,
    });
    await expect(p.generateText({ prompt: "x" })).rejects.toThrow(/not installed/);
  });

  test("rejects unknown presets without a command", () => {
    expect(() => createProvider("x", { type: "agent-cli", preset: "nope", timeoutMs: 5000 })).toThrow(ProviderError);
  });
});

describe("openai-compatible provider", () => {
  test("posts chat completions and reads the reply", async () => {
    let body: any;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] });
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: "ds",
      baseUrl: "https://api.example.com/v1/",
      model: "m",
      apiKey: "k",
      jsonMode: true,
      fetch: fakeFetch,
    });
    expect(await p.generateText({ system: "s", prompt: "ping" })).toBe("pong");
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "ping" },
    ]);
  });

  test("surfaces HTTP errors", async () => {
    const fakeFetch = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ id: "ds", baseUrl: "https://x/v1", model: "m", jsonMode: false, fetch: fakeFetch });
    await expect(p.generateText({ prompt: "x" })).rejects.toThrow(/HTTP 401/);
  });
});

describe("config", () => {
  test("round-trips through disk and resolves the default provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ojs-test-"));
    try {
      const path = join(dir, "config.json");
      expect(await loadConfig(path)).toEqual(Config.parse({}));
      await saveConfig(
        Config.parse({ defaultProvider: "cat", providers: { cat: { type: "agent-cli", preset: "custom", command: "cat" } } }),
        path,
      );
      const cfg = await loadConfig(path);
      expect(resolveProvider(cfg).id).toBe("cat");
      // Light jobs use the light model when there is one, and the main model when not.
      expect(resolveProvider(cfg, undefined, {}, { light: true }).id).toBe("cat");
      const withLight = Config.parse({ defaultProvider: "c", providers: { c: { type: "agent-cli", preset: "claude", lightModel: "haiku" } } });
      expect(resolveProvider(withLight, undefined, {}, { light: true }).id).toBe("c (haiku)");
      expect(resolveProvider(withLight).id).toBe("c");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid config with a readable error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ojs-test-"));
    try {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ providers: { x: { type: "telepathy" } } }));
      await expect(loadConfig(path)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("API keys come from env vars, never from config", () => {
    expect(() =>
      createProvider("ds", { type: "openai-compatible", baseUrl: "https://x/v1", model: "m", apiKeyEnv: "OJS_TEST_UNSET", jsonMode: true }, {}),
    ).toThrow(/OJS_TEST_UNSET is not set/);
  });
});

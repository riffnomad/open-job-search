import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { extractJson, generateObject, type LLMProvider, ProviderError } from "../src/index.ts";

describe("extractJson", () => {
  test("plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  test("code fence", () => {
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2]}\n```\nThanks')).toEqual({ a: [1, 2] });
  });
  test("embedded in prose, with braces inside strings", () => {
    expect(extractJson('Sure! {"note": "use {curly} braces", "n": 2} hope that helps')).toEqual({
      note: "use {curly} braces",
      n: 2,
    });
  });
  test("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(SyntaxError);
  });
});

function scripted(replies: string[]): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake",
    kind: "api",
    prompts,
    async generateText(req) {
      prompts.push(req.prompt);
      const next = replies.shift();
      if (next === undefined) throw new Error("no more scripted replies");
      return next;
    },
  };
}

const Fit = z.object({ score: z.number().min(1).max(5), reasons: z.array(z.string()) });

describe("generateObject (prompt-and-validate fallback)", () => {
  test("returns valid output on the first try", async () => {
    const p = scripted(['{"score": 4, "reasons": ["Go experience"]}']);
    expect(await generateObject(p, { prompt: "rate", schema: Fit })).toEqual({ score: 4, reasons: ["Go experience"] });
    expect(p.prompts[0]).toContain("JSON Schema");
  });

  test("retries with validation errors, then succeeds", async () => {
    const p = scripted(['{"score": 9, "reasons": []}', '{"score": 5, "reasons": []}']);
    expect(await generateObject(p, { prompt: "rate", schema: Fit })).toEqual({ score: 5, reasons: [] });
    expect(p.prompts[1]).toContain("did not match the schema");
  });

  test("gives up after maxAttempts", async () => {
    const p = scripted(["nope", "still nope"]);
    await expect(generateObject(p, { prompt: "rate", schema: Fit })).rejects.toBeInstanceOf(ProviderError);
  });

  test("uses native structured output when the provider has it", async () => {
    const p: LLMProvider = {
      id: "native",
      kind: "api",
      generateText: async () => {
        throw new Error("should not be called");
      },
      generateObjectNative: async <T>() => ({ score: 3, reasons: [] }) as T,
    };
    expect(await generateObject(p, { prompt: "rate", schema: Fit })).toEqual({ score: 3, reasons: [] });
  });
});

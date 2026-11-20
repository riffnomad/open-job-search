import { z } from "zod";
import { type LLMProvider, type ObjectRequest, ProviderError } from "./types.ts";

/**
 * Pull the first JSON value out of model output. Agent CLIs and smaller
 * models often wrap JSON in prose or code fences.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }

  // Scan for a balanced {...} or [...] block, respecting strings.
  for (let start = 0; start < trimmed.length; start++) {
    const open = trimmed[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new SyntaxError("No JSON object found in model output");
}

function jsonInstructions(schema: z.ZodType, name: string): string {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);
  return [
    `Respond with a single JSON value named "${name}" that matches this JSON Schema.`,
    "Output only the JSON. No prose, no code fences.",
    "",
    jsonSchema,
  ].join("\n");
}

/**
 * Get schema-valid output from any provider.
 *
 * Uses the provider's native structured output when it has one. Otherwise
 * asks for JSON, validates it, and retries with the validation errors so the
 * model can correct itself.
 */
export async function generateObject<T>(
  provider: LLMProvider,
  req: ObjectRequest<T>,
  { maxAttempts = 2 }: { maxAttempts?: number } = {},
): Promise<T> {
  if (provider.generateObjectNative) return provider.generateObjectNative(req);

  const name = req.name ?? "result";
  const instructions = jsonInstructions(req.schema, name);
  let prompt = `${req.prompt}\n\n${instructions}`;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await provider.generateText({ ...req, prompt });
    let candidate: unknown;
    try {
      candidate = extractJson(text);
    } catch (err) {
      lastError = (err as Error).message;
      prompt = `${req.prompt}\n\n${instructions}\n\nYour previous reply contained no valid JSON. Reply with only the JSON.`;
      continue;
    }
    const parsed = req.schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    lastError = z.prettifyError(parsed.error);
    prompt = [
      req.prompt,
      "",
      instructions,
      "",
      "Your previous reply did not match the schema:",
      lastError,
      "",
      "Previous reply:",
      JSON.stringify(candidate),
      "",
      "Reply again with corrected JSON only.",
    ].join("\n");
  }
  throw new ProviderError(
    provider.id,
    `could not produce valid "${name}" after ${maxAttempts} attempts: ${lastError}`,
  );
}

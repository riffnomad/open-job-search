import type { z } from "zod";

export interface GenerateRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface ObjectRequest<T> extends GenerateRequest {
  schema: z.ZodType<T>;
  /** Short name for the output, used in prompts and errors (e.g. "job_evaluation"). */
  name?: string;
}

/**
 * The single seam between open-job-search and any AI model.
 *
 * Everything in core talks to this interface. Adapters exist for model APIs
 * (Anthropic, any OpenAI-compatible server) and for agent CLIs the user is
 * already signed in to (claude, codex, gemini, agy, opencode, custom).
 */
export interface LLMProvider {
  readonly id: string;
  readonly kind: "api" | "agent-cli";
  generateText(req: GenerateRequest): Promise<string>;
  /**
   * Optional native structured output. When absent, `generateObject` in
   * structured.ts falls back to prompting for JSON and validating it.
   */
  generateObjectNative?<T>(req: ObjectRequest<T>): Promise<T>;
}

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly providerId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${providerId}] ${message}`, options);
  }
}

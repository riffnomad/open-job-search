import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { type GenerateRequest, type LLMProvider, type ObjectRequest, ProviderError } from "../types.ts";

export interface AnthropicOptions {
  id: string;
  model: string;
  apiKey?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicProvider implements LLMProvider {
  readonly kind = "api" as const;
  readonly id: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    this.id = opts.id;
    // With no apiKey the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  private base(req: GenerateRequest) {
    const fallback = FALLBACK_MODELS.test(this.opts.model);
    return {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? 16000,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: "user" as const, content: req.prompt }],
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
  }

  private checkStop(message: BetaMessage): void {
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? "unspecified";
      throw new ProviderError(this.id, `model declined the request (category: ${category})`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new ProviderError(this.id, "output hit max_tokens before finishing; raise maxTokens");
    }
  }

  async generateText(req: GenerateRequest): Promise<string> {
    try {
      const message = await this.client.beta.messages.create({
        ...this.base(req),
        ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
      });
      this.checkStop(message);
      return message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async generateObjectNative<T>(req: ObjectRequest<T>): Promise<T> {
    try {
      const message = await this.client.beta.messages.parse({
        ...this.base(req),
        output_config: {
          format: betaZodOutputFormat(req.schema),
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        },
      });
      this.checkStop(message);
      if (message.parsed_output == null) {
        throw new ProviderError(this.id, `response did not match the "${req.name ?? "result"}" schema`);
      }
      return message.parsed_output as T;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private wrap(err: unknown): Error {
    if (err instanceof ProviderError) return err;
    if (err instanceof Anthropic.AuthenticationError) {
      return new ProviderError(this.id, "authentication failed: set the API key env var or run `ant auth login`", { cause: err });
    }
    if (err instanceof Anthropic.NotFoundError) {
      return new ProviderError(this.id, `model "${this.opts.model}" not found`, { cause: err });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return new ProviderError(this.id, "rate limited; try again shortly", { cause: err });
    }
    if (err instanceof Anthropic.APIError) {
      return new ProviderError(this.id, `API error ${err.status ?? ""}: ${err.message}`, { cause: err });
    }
    return new ProviderError(this.id, (err as Error)?.message ?? String(err), { cause: err });
  }
}

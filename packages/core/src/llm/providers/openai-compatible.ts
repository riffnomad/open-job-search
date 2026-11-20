import { generateObject } from "../structured.ts";
import { type GenerateRequest, type LLMProvider, type ObjectRequest, ProviderError } from "../types.ts";

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  jsonMode: boolean;
  fetch?: typeof fetch;
}

/**
 * Any server that speaks the OpenAI Chat Completions format: OpenAI,
 * DeepSeek, OpenRouter, Gemini's OpenAI endpoint, Groq, Mistral, Ollama,
 * LM Studio, vLLM and more.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly kind = "api" as const;
  readonly id: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
  }

  async generateText(req: GenerateRequest, json = false): Promise<string> {
    const doFetch = this.opts.fetch ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ];
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch (err) {
      throw new ProviderError(this.id, `could not reach ${url}: ${(err as Error).message}`, { cause: err });
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new ProviderError(this.id, `HTTP ${res.status} from ${url}: ${body}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new ProviderError(this.id, "output was cut off at the token limit; raise maxTokens");
    }
    const content = choice?.message?.content;
    if (typeof content !== "string") throw new ProviderError(this.id, "response had no message content");
    return content;
  }

  generateObjectNative<T>(req: ObjectRequest<T>): Promise<T> {
    // Reuse the prompt-and-validate loop, but with JSON mode on so the server constrains output.
    const jsonMode = this.opts.jsonMode;
    const inner: LLMProvider = {
      id: this.id,
      kind: this.kind,
      generateText: (r) => this.generateText(r, jsonMode),
    };
    return generateObject(inner, req);
  }
}

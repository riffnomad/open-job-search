import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GenerateRequest, type LLMProvider, ProviderError } from "../types.ts";

export interface AgentCliPreset {
  command: string;
  args: string[];
  /** Flag used to pick a model, e.g. "--model". */
  modelFlag?: string;
  /** Flag that writes the final answer to a file, for CLIs that print progress to stdout. */
  outputFileFlag?: string;
  /** Verified against the real CLI by a maintainer. Unverified presets are best-effort. */
  verified: boolean;
}

/**
 * Built-in presets for agent CLIs people already pay for and are signed in
 * to. `{prompt}` in args is replaced with the prompt; if absent, the prompt
 * is sent on stdin. Each CLI runs in an empty temporary directory so it has
 * no project files to read or change.
 */
export const AGENT_CLI_PRESETS: Record<string, AgentCliPreset> = {
  claude: {
    command: "claude",
    args: ["-p", "--no-session-persistence", "--output-format", "text"],
    modelFlag: "--model",
    verified: true,
  },
  codex: {
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only"],
    modelFlag: "-m",
    outputFileFlag: "--output-last-message",
    verified: true,
  },
  gemini: {
    command: "gemini",
    // --skip-trust: we run in an empty temp dir. --approval-mode plan: read-only.
    // Note: Google no longer serves Gemini CLI on the free individual tier; those users should use agy.
    args: ["--output-format", "text", "--skip-trust", "--approval-mode", "plan", "-p", "Follow the instructions given on stdin."],
    modelFlag: "--model",
    verified: false,
  },
  agy: {
    command: "agy",
    args: ["--print", "{prompt}"],
    modelFlag: "--model",
    verified: true,
  },
  opencode: {
    command: "opencode",
    args: ["run", "{prompt}"],
    modelFlag: "-m",
    verified: false,
  },
};

export interface AgentCliOptions {
  id: string;
  preset: string;
  command?: string;
  args?: string[];
  model?: string;
  timeoutMs: number;
}

export class AgentCliProvider implements LLMProvider {
  readonly kind = "agent-cli" as const;
  readonly id: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly preset: AgentCliPreset | undefined;

  constructor(private readonly opts: AgentCliOptions) {
    this.id = opts.id;
    this.preset = AGENT_CLI_PRESETS[opts.preset];
    if (!this.preset && !opts.command) {
      throw new ProviderError(
        opts.id,
        `unknown preset "${opts.preset}" and no command given. Presets: ${Object.keys(AGENT_CLI_PRESETS).join(", ")}`,
      );
    }
    this.command = opts.command ?? this.preset!.command;
    this.args = opts.args ?? this.preset?.args ?? [];
  }

  async generateText(req: GenerateRequest): Promise<string> {
    // Agent CLIs have no separate system channel, so the system prompt leads the input.
    const fullPrompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
    const workdir = await mkdtemp(join(tmpdir(), "ojs-agent-"));
    try {
      const usesArg = this.args.some((a) => a.includes("{prompt}"));
      const args = this.args.map((a) => a.replaceAll("{prompt}", fullPrompt));
      // Appended, not prepended: presets may start with a subcommand (`codex exec`, `opencode run`).
      if (this.opts.model && this.preset?.modelFlag) args.push(this.preset.modelFlag, this.opts.model);
      const outFile = this.preset?.outputFileFlag ? join(workdir, "answer.txt") : undefined;
      if (outFile) args.push(this.preset!.outputFileFlag!, outFile);

      const stdout = await this.run(args, usesArg ? undefined : fullPrompt, workdir);
      const answer = outFile ? await readFile(outFile, "utf8").catch(() => stdout) : stdout;
      if (!answer.trim()) throw new ProviderError(this.id, "the CLI returned no output");
      return answer.trim();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private run(args: string[], stdin: string | undefined, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new ProviderError(this.id, `timed out after ${this.opts.timeoutMs / 1000}s`));
      }, this.opts.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new ProviderError(
            this.id,
            e.code === "ENOENT" ? `"${this.command}" is not installed or not on PATH` : e.message,
            { cause: e },
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new ProviderError(this.id, `"${this.command}" exited with code ${code}: ${err.trim().slice(-500)}`));
      });
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }
}

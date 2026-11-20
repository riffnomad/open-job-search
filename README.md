# open-job-search

**Find roles early. Find your way in. Apply well.**

An open-source AI job search tool for everyone, whatever your role or background. Use it from the command line (`ojs`) or a local web app. Bring whichever AI you already use: Claude, Codex, Antigravity, DeepSeek, OpenRouter, a local model through Ollama, and more.

> **Status: early development.** The foundation (provider layer, CLI, config) works. Job discovery, evaluation and applications are next. See the [roadmap](#roadmap).

## What makes it different

- **A real app, not only prompts.** A CLI *and* a local web app over one core, plus a background worker that watches for roles and pings you, instead of only working while an AI session is open.
- **Any provider, two ways.** Use an API key (Anthropic, any OpenAI-compatible server), *or* the agent CLI you already pay for and are signed in to (`claude`, `codex`, `agy`, `opencode`, …). No extra subscription needed.
- **Network first.** Referrals beat cold applications. For every good match, it looks for the warmest way in.
- **Your data stays yours.** Everything lives in `~/.ojs` on your machine, never in this repo. Nothing is sent anywhere except to the AI provider you choose.
- **UK first, then everywhere.** Starting with London, the UK and remote roles: GBP salaries, UK CV conventions, and the Home Office register of visa sponsors.
- **You press Submit.** It drafts and recommends. It never applies or sends messages on your behalf.

## Quick start

Requires [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/riffnomad/open-job-search.git
cd open-job-search
bun install

bun run ojs init        # detects installed agent CLIs and API keys
bun run ojs providers   # see what's configured
bun run ojs ask "Say hello"
bun run web             # local web app on http://127.0.0.1:4717
```

### Adding a provider

API keys are never written to config. You name the environment variable that holds the key:

```bash
# DeepSeek (or any OpenAI-compatible server)
bun run ojs providers add deepseek --type openai-compatible \
  --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key-env DEEPSEEK_API_KEY

# Ollama, fully local
bun run ojs providers add local --type openai-compatible \
  --base-url http://localhost:11434/v1 --model llama3.1

# Anthropic API
bun run ojs providers add anthropic --type anthropic --model claude-opus-5-5 --api-key-env ANTHROPIC_API_KEY

# Any agent CLI that takes a prompt on stdin
bun run ojs providers add mine --type agent-cli --command my-agent
```

| Agent CLI preset | Status |
|---|---|
| `claude` (Claude Code) | verified |
| `codex` (OpenAI Codex) | verified |
| `agy` (Antigravity) | verified |
| `gemini` (Gemini CLI) | best-effort; Google no longer serves it on the free individual tier |
| `opencode` | best-effort, help us verify it |

### Using it from an AI agent

Every command takes `--json`, so Claude Code, Codex or any agent can drive `ojs` directly.

## Roadmap

1. **Foundation**: provider layer, config, CLI, web and worker skeletons ✅
2. **Profile**: import a CV (PDF, text, LinkedIn export) into a structured profile
3. **Discovery**: company job boards (Greenhouse, Lever, Ashby, Workable), UK sources (Adzuna, Reed), remote boards; dedup and liveness checks
4. **Evaluation**: structured fit scoring with reasons and hard blockers (visa sponsorship, location, level)
5. **Warm paths**: match roles to your network and draft referral asks
6. **Applications**: tailored CV, cover letter and form answers, with fact checks so nothing is invented
7. **Tracking and follow-ups**: pipeline, reminders, outcomes, learning from results
8. **Interviews and offers**: prep, story bank, mock interviews, negotiation

## Contributing

Early days, so the shape is still moving. Issues and ideas are very welcome. See [AGENTS.md](AGENTS.md) for how the code is organised and the rules that keep it safe.

## License

[MIT](LICENSE)

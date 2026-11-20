# open-job-search

**Find roles early. Find your way in. Apply well.**

An open-source AI job search assistant for everyone, whatever your role or background. Clone the repo, open the AI agent you already use (Claude Code, Codex, Antigravity, opencode…) inside it, and talk to it. A local web app is coming for people who'd rather not use a terminal.

> **Status: early development.** Building your profile from a CV works. Job discovery, evaluation and applications are next. See the [roadmap](#roadmap).

## What makes it different

- **An experience bank, not just a CV.** A CV holds a fraction of what you did. Your profile keeps one file per job and grows as your agent interviews you about it, so every application can draw on far more than two pages.
- **Past lives count.** Bar work, retail, trades, the career before this one: kept with the skills and stories they gave you, and brought back when a role makes them relevant.
- **Network first.** Referrals beat cold applications. For every good match, it looks for the warmest way in.
- **Any agent.** Works in whichever agent CLI you use. No extra subscription.
- **Always on.** A background worker watches for roles and pings you, even when no agent session is open.
- **UK first, then everywhere.** Starting with London, the UK and remote roles: GBP salaries, UK CV conventions, and the Home Office register of visa sponsors.
- **You press Submit.** It drafts and recommends. It never applies or sends messages on your behalf.

## Quick start

Requires [Bun](https://bun.sh) 1.3+ and an agent CLI such as [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), Antigravity or opencode.

```bash
git clone https://github.com/riffnomad/open-job-search.git
cd open-job-search
bun install
```

Put your CV (PDF, Word, Markdown or text) in [`documents/`](documents/README.md), then open your agent in the repo and ask it to set you up:

```bash
claude        # or codex, agy, opencode
> Set me up and import my CV
```

It reads your CV, asks you about anything it isn't sure of before saving, then offers to interview you role by role to get down what your CV left out. The workflows are plain-text skills in [`.agents/skills/`](.agents/skills/).

## Your files

Two folders hold everything personal. Both are ignored by git, so nothing you add ever ends up in the public repo:

- [`documents/`](documents/README.md): what you put in. CVs, references, writing samples.
- [`data/`](data/README.md): what the tool builds. Your profile (`data/profile/`), settings, cache.

Your profile is plain Markdown and YAML. Read it, edit it, back it up.

## Commands

Your agent runs these for you, but you can too. Every command takes `--json`.

```bash
bun run ojs init                    # find your agent CLIs and set one as default
bun run ojs profile                 # overview of your profile
bun run ojs profile import          # import new files in documents/ (shows changes, asks first)
bun run ojs profile gaps            # what's missing in each role
bun run ojs profile edit [role]     # open in your editor, checked when you save
bun run ojs help                    # everything else
```

### AI providers

Inside your agent, your agent does the thinking. When `ojs` needs AI on its own (importing a CV from the command line, the web app, the background worker), it calls your agent CLI headless, or an API if you prefer. `ojs init` sets this up.

| Agent CLI | Status |
|---|---|
| `claude` (Claude Code) | verified |
| `codex` (OpenAI Codex) | verified |
| `agy` (Antigravity) | verified |
| `gemini` (Gemini CLI) | best-effort; Google no longer serves it on the free individual tier |
| `opencode` | best-effort, help us verify it |

APIs work too. Keys are never written to config; you name the environment variable that holds the key:

```bash
bun run ojs providers add deepseek --type openai-compatible \
  --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
bun run ojs providers add local --type openai-compatible --base-url http://localhost:11434/v1 --model llama3.1
bun run ojs providers add anthropic --type anthropic --model claude-opus-5-5 --api-key-env ANTHROPIC_API_KEY
```

## Roadmap

1. **Foundation**: provider layer, config, tools, web and worker skeletons ✅
2. **Profile**: CV import ✅, then interviews that deepen each role, past lives, preferences, LinkedIn export
3. **Discovery**: company job boards (Greenhouse, Lever, Ashby, Workable), UK sources (Adzuna, Reed), remote boards; dedup and liveness checks
4. **Evaluation**: structured fit scoring with reasons and hard blockers (visa sponsorship, location, level)
5. **Warm paths**: match roles to your network and draft referral asks
6. **Applications**: tailored CV, cover letter and form answers, with fact checks so nothing is invented
7. **Tracking and follow-ups**: pipeline, reminders, outcomes, learning from results
8. **Interviews and offers**: prep, story bank, mock interviews, negotiation

## Contributing

Early days, so the shape is still moving. Issues and ideas are very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is organised and the rules that keep it safe.

## License

[MIT](LICENSE)

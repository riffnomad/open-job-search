---
name: flow
description: The path through open-job-search, one step at a time, each finished before the next. The entry point whenever someone opens the repo, says "set me up", "let's start", "what's next", "carry on", or asks where they are. Checks progress with `ojs flow`, explains the steps, runs the current step's skills, and moves on only when the person is happy.
---

# The flow

open-job-search works in steps. Each step is finished before the next one starts. The person decides when a step is finished; the tools only remember where they are, so any session (or any agent) picks up in the same place.

**Steps 1 and 2 are discovery**: learn everything about the person before looking at a single job. Their experience, skills, projects, results, hard decisions, best work, other jobs they've had. A big, true bank of who they are. Don't ask what job they want, or about salary or locations, during these steps; that comes later, and it shouldn't steer what they tell you.

| Step | What | Skills |
|---|---|---|
| 1. Your experience | Their CV, then everything it left out, role by role | [import-cv](../import-cv/SKILL.md), then [dig](../dig/SKILL.md) |
| 2. Past lives | Other jobs, before or alongside their career, and what they gave them | [past-lives](../past-lives/SKILL.md), then [dig](../dig/SKILL.md) |

More steps (preferences, discovery, evaluation, applications…) come later.

## Every session

1. Run `bun run ojs flow --json`. `current` is the step they're on; each step has `progress`, `suggestions` (what could still be added) and `blockers`.
2. **First time** (step 1, nothing in the profile): explain in a few plain sentences how this works: we go step by step; first we get to know them really well, starting with their CV and then everything it left out; only after that do we look at jobs. The more they tell us, the better the roles we can find. Then start step 1.
3. **Coming back**: say where they are in one line ("We're on step 1, your experience. Acme is in good shape; Globex and Initech haven't been dug into yet.") and carry on with the current step, starting from its suggestions.
4. Stay inside the current step. If they bring up something from a later step (an old job during step 1, a job they want during step 2), say you'll come to it in step N, and keep a note so it isn't lost: for an old job, create it with `profile add past-life` and nothing else, and dig into it in step 2.

## Finishing a step

The person decides when a step is done. Never push them on, never hold them back.

- When the current step's suggestions run out, or they say they've had enough for this step, sum up what's there in a sentence or two (from `progress`).
- Mention, once and lightly, what could still be added (from `suggestions`), and that **the more they fill in, the better the information for finding relevant roles**. They can always come back to it later.
- Ask if they want to move on. On a yes: `bun run ojs flow done <step> --json`, then introduce the next step and why it matters, and follow its skills.
- If they want to go back to an earlier step later: `bun run ojs flow reopen <step> --json` (the steps after it are reopened too, so they're gone through again in order).

They can stop any time. Next session, `ojs flow` brings them back to the same place.

---
name: flow
description: The path through open-job-search, one step at a time, each finished before the next. The entry point whenever someone opens the repo, says "set me up", "let's start", "what's next", "carry on", asks where they are, or wants to work on someone else's search or another of their searches. Settles whose profile this is, checks progress with `ojs flow`, explains the steps, runs the current step's skills, and moves on only when the person is happy.
---

# The flow

open-job-search works in steps. Each step is finished before the next one starts. The person decides when a step is finished; the tools only remember where they are, so any session (or any agent) picks up in the same place.

**Steps 1 and 2 are discovery**: learn everything about the person before looking at a single job. Their experience, skills, projects, results, hard decisions, best work, other jobs they've had. A big, true bank of who they are. Don't ask what job they want, or about salary or locations, during these steps; that comes later, and it shouldn't steer what they tell you.

| Step | What | Skills |
|---|---|---|
| 1. Your experience | Their CV, then everything it left out, role by role | [import-cv](../import-cv/SKILL.md), then [dig](../dig/SKILL.md) |
| 2. Past lives | Other jobs, before or alongside their career, and what they gave them | [past-lives](../past-lives/SKILL.md), then [dig](../dig/SKILL.md) |
| 3. Roles to aim for | What they want to look for and why, how well the profile backs it, and how many searches that makes | [targets](../targets/SKILL.md) |
| 4. What you want from the job | Where and how they work, pay, the kind of company, what rules a job out, what matters most, and why. For each search | [preferences](../preferences/SKILL.md) |

More steps (the angle to lead with, finding roles, evaluation, applications…) come later. Steps 1 to 3 are done once per person. Step 4 onwards is done for each **search** (what they're looking for, e.g. "software engineering" and "product management"), so starting a second search never repeats discovery. For search steps, say which search you're on, and when `progress` lists "Other searches still to do", offer to do those next (`ojs search use <name>`).

## Whose search is this

One workspace can hold several people: someone may run their own search and a partner's. The one typing isn't always the person whose search it is.

- **No one set up yet** (`ojs flow` errors with "no one is set up yet"): ask whose job search this is, and their name. Then `bun run ojs person add "<name>" --json`, and tell them where to put the CV: the `documents` path in the result.
- **A profile from before people existed** (the error mentions `person migrate`): ask whose profile it is, then `bun run ojs person migrate "<name>" --json`. Nothing is lost; it's a move.
- **More than one person** (`ojs person --json` lists several): every session, start by saying whose profile you're on ("We're working on Sam's search.") so they can switch. To switch: `bun run ojs person use <name> --json`.
- **Running it for someone else**: ask the questions about that person ("What did Sam do at…?"), and take the answers from whoever is typing. Only what they know for sure goes in; anything they're guessing about the other person goes under "To confirm", or under "Still to ask" for when that person can answer.
- Keep an eye on `workingOn` in every result. If it's not who you meant, stop and switch before writing anything. Never copy anything between people.

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

## Another search later

If they want to look for something new after step 3 ("I also want to try product roles"), follow the [targets](../targets/SKILL.md) skill for it, whatever step they're on: it checks what's changed in their profile first, then the new role's fit. Then do step 4 for the new search: only what's different from their usual preferences.

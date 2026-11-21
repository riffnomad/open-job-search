---
name: dig
description: Interview the person about one role or past life at a time, one question per message, pushing for specifics (numbers, scale, how, what changed) until the role has real depth, and write each answer into their profile. Use after a CV import, when they say "dig", "interview me", "grill me", "go deeper on <role>", or when `ojs profile gaps` shows thin roles.
---

# Dig into a role

A CV holds a fraction of what someone did. Your job is to get the rest out of their head and into their profile: specific, true, and in their own words. Be a good interviewer: curious, persistent, warm. Don't accept the first vague answer, but never make them feel bad.

Follow the **Facts, not polish** rules in [AGENTS.md](../../../AGENTS.md) throughout.

## 1. Pick a role

- If they named one, use it. Otherwise run `bun run ojs profile gaps --json` and suggest the role that matters most for what they want next (check `preferences` in `bun run ojs profile --json`), or the thinnest recent one. Say why in one line.
- Read it in full: `bun run ojs profile show <role> --json`. Know what's there before you ask, so you never ask for something they already told you.

## 2. Clear "To confirm" first

For each bullet under **To confirm**, ask whether it's right, one per message. Yes: add it as a fact under the right heading with `--source dig`. No: tell them you'll remove it, and on their OK run `bun run ojs profile correct <role> --find "<the line's text>" --remove --json`. Unsure: leave it.

## 3. Grill, one question at a time

Ask **one question per message**, in plain text. Build each question on what's already in the file or what they just said, never a generic form ("You cut delivery planning from 40 minutes to 3. What made it take 40?").

Work through what the gaps report shows, then wider:

- **Scope and scale:** how big (people, money, volume, users, sites, customers), who for, how long.
- **Their part:** what they did themselves versus the team. Ask "what did you do?" when they say "we".
- **How:** the approach, the tools, the decisions and why.
- **Outcome:** what changed, for whom. Before and after. Numbers if they have them, honest estimates if they say so ("about 30"), nothing if they don't.
- **Hard moments:** what went wrong, what they did, what happened next.
- **People:** who they led, helped, hired, persuaded, dealt with.
- **Recognition:** promotions, praise, what a manager would say they were best at.
- **Hidden depth:** anything they did a lot of that never made the CV.

Push, kindly:
- Vague answer ("I improved performance"): ask for one concrete example, or what "improved" looked like.
- No numbers: ask once if they can put a size on it. If not, move on without fuss.
- A great story: get the situation, what they did, and the result before moving on.
- Follow up while it's flowing. Move to the next area when they've said what they know.

## 4. Write as you go

After every answer, or every two or three short ones:

1. Turn what they said into bullets in their words. Don't polish, don't upgrade ("helped with" stays "helped with").
2. Put each under the right heading: `Context`, `What I owned`, `Projects` (with `--sub "<project>"`), `Achievements`, `Hard moments`, `People and leadership`, `Skills in depth`, `Stories`.
3. Show the exact lines, then on their OK (a quick "yes", or carrying on, is enough once they've seen the pattern) write them:
   `bun run ojs profile add-bullets <role> --section "<heading>" [--sub "<project>"] [--as "<position>"] --source dig --text "…" [--text "…"] --json`

   If the role has several positions and it's not obvious which one an answer is about, ask, and pass it with `--as`.

Never lose an answer: write before moving to the next role or stopping.

If they correct something already in the file (a wrong number, a word they wouldn't use, a CV line that isn't true), show the before and after, then use `bun run ojs profile correct <role> --find "…" --replace "…" --json`. If they change their mind about something you just wrote, `profile undo` reverses it.

## 5. Move on or stop

- When a role feels well covered (run `profile gaps <role> --json` to check), say what you've added and offer the next role.
- Good questions you didn't get to: save them under `Still to ask` with `--source dig`, so the next session can pick up there.
- They can stop any time. When they do, say briefly what was added and what's still open.

## Past lives

Finding and setting up past lives is the [past-lives skill](../past-lives/SKILL.md). If they have none yet, at a natural break offer to go through what they did before or alongside this career, and follow that skill.

Digging into a past life works the same as a role, with its own headings: `What I did`, `Transferable skills`, `Stories`, `Trade knowledge`. Focus on:

- **Transferable skills, each with proof.** A skill on its own is worth little ("good under pressure"). Pin each one to a moment that shows it ("ran the bar alone on New Year's Eve, 300 people, nobody waited more than a few minutes"). Ask "when did that happen?" until you have one. Write the skill and the moment as one line.
- **Stories:** the busy Saturday, the difficult customer, the thing that went wrong and how they fixed it.
- **Trade knowledge:** what they know that most people don't (how to price a job, read a room, fix an engine, calm someone down).
- **Scale, loosely:** how many customers, covers, sites or people, as they remember it. Estimates as they say them.

---
name: past-lives
description: Step 2 of the flow. Find the person's past lives (earlier careers and work outside their main field, like bar work, retail, trades, caring, the forces or volunteering), explain why they matter, set them up in the profile, and hand each to the dig skill. Use when `ojs flow` says the current step is past-lives.
---

# Past lives

Most people have done more than their current career: the bar job through university, ten years as a mechanic, running a shop, caring for a parent. They rarely put it on a CV, and often wave it away ("it was just bar work"). But it holds real skills and stories, and for some roles it's exactly what makes them stand out. Your job is to find these, make them count, and get them into the profile.

Follow the **Facts, not polish** rules in [AGENTS.md](../../../AGENTS.md) throughout. This is step 2 of the [flow](../flow/SKILL.md): only start it once step 1 is done.

## 1. Say why we're asking

Before any question, explain in a few plain sentences why this step exists, so it doesn't feel like prying or like their current career isn't enough:

- Other jobs often give skills that carry over: handling pressure, dealing with people, running a team, fixing things under a deadline.
- Sometimes they're directly relevant later. Someone who used to be a mechanic might be exactly who a car maker wants for a software engineering role. Someone who worked in a shop understands the customers of a retail tech company.
- Any job counts, including ones that don't feel like "career": bar work, a trade, care work, the forces, raising kids, volunteering.

## 2. See what's there

Run `bun run ojs profile --json`. Look at `pastLives`, and at `roles` for jobs that look like an earlier career: a different field from their recent work, usually older, often short.

## 3. Imported roles that look like a past life

For each one, ask (one per message) whether it was part of a different chapter, in plain words: "Your CV has two years as a bartender at The Crown before you moved into software. Shall I keep that as a past life? It's where things like that live, with the skills and stories they gave you, instead of sitting alongside your tech roles."

On a yes, ask what to call the field if it isn't obvious ("Hospitality", "Trades", "Retail"), then:

1. Preview: `bun run ojs profile move <role> --to past-life --field "<field>" --dry-run --json`
2. Tell them where things will go (for example "Achievements and responsibilities go under What I did, hard moments under Stories"). Every line keeps its source.
3. On their OK, run it without `--dry-run`. If a past life with that field exists, it adds to it, so two bar jobs end up together under Hospitality.

On a no, leave it as a role.

## 4. Ask what else they've done

Ask, warmly and once: have they ever held other jobs, before this career or alongside it? Give examples so it's clear anything counts: "bar or restaurant work, retail, a trade, driving, care work, the forces, raising kids, volunteering, running something of your own". Some already exist from step 1, if they mentioned them then: check `pastLives` and pick those up first. Then follow up on each one they mention, one at a time:

- What was the work, roughly when, and for how long? Fuzzy is fine ("a few summers in my twenties", "most of the 2000s"). Don't push for months.
- Where, if they want to say.

For each, create it: `bun run ojs profile add past-life --field "<field>" --title "<what they did>" --json`. One past life per field: a waiter job and a bartending job both go under Hospitality. Add the details with `profile add-bullets <field> --section "What I did" --source dig`.

Never make them feel a past life is less than their current career, or that a gap needs explaining. Caring for family or raising children is a past life like any other.

## 5. Dig

Hand each past life to the [dig skill](../dig/SKILL.md), starting with the one they light up about. If they'd rather stop, save what you'd ask under `Still to ask` so the next session can pick it up.

If they've never had other jobs, that's completely fine: say so, and go back to the [flow skill](../flow/SKILL.md) to finish the step. Same when every past life has been dug into, or they've had enough.

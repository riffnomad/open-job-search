---
name: targets
description: Step 3 of the flow. Find out which roles the person wants to look for and why, check each honestly but gently against their profile, decide with them how many searches that makes, and save each search with its reasons and fit. Also whenever they want to start a new search later ("I also want to look at product roles"), and when `ojs flow` or `ojs search` says a fit needs checking again.
---

# Roles to aim for

Steps 1 and 2 built a big, true bank of who the person is. Now we find out what they want to aim for, and how well that bank backs it. **Their choice always wins.** Your job is to understand it, be honest about how hard it might be when that's really true, and set up the right searches.

Follow the **Facts, not polish** rules in [AGENTS.md](../../../AGENTS.md) throughout, and ask **one question per message**. This is step 3 of the [flow](../flow/SKILL.md).

## 0. Starting a new search later? First, what's changed

If they already have searches (`bun run ojs search --json` lists them) and want another, or `needsAssessing` is true for any of them, their profile may be out of date before you judge anything against it. Ask first: "Before we look at this, has anything changed since we last went through your profile? A new job or role, a course or bootcamp, something new you've learnt or built?"

- Anything new goes into the profile first, the usual way: a new CV through [import-cv](../import-cv/SKILL.md), a new role with `profile add role`, then [dig](../dig/SKILL.md) for the detail. Keep it short; this isn't step 1 again.
- Then re-check every search whose fit has `needsAssessing: true` (section 4), and save the new fit even if it hasn't changed, so it's current.

## 1. What do they want to look for?

Ask in plain words, before offering any ideas of your own, so theirs isn't steered: "What kind of role do you want to look for? It can be more than one."

## 2. Why?

For each role they name, ask why (one at a time): moving up, a change of direction, interest, money, how things are at their current job, a step towards something else. Listen for what's underneath. "I want to be a CTO because I want to shape the product" might point at head of engineering at a small company too. If it does, mention it as an option, not a correction.

Write down their reasons in their words. They're saved with the search.

## 3. Read the profile

`bun run ojs profile --json`, then `bun run ojs profile show <role> --json` for each role and past life that could matter. You're looking for evidence for each role, at the level they're aiming for: work they've done, projects, results, stories, skills, past lives, education.

## 4. How well does the profile back it?

Judge each role against **what that role needs at the level they're aiming for**, not against the most senior version of it:

- **good**: the profile clearly covers it.
- **stretch**: most of it is there, with a gap or two. A senior engineer going for staff, an engineer going for their first manager role. This is normal and healthy; most people should be aiming here.
- **leap**: the profile has almost nothing the role needs, at any level. A software engineer with no finance background going for head of finance.

**Flag a leap only when it really is one.** Someone fresh out of university or a bootcamp going for a junior role is a good fit, not a leap: their projects, coursework and past lives are the evidence, and junior roles expect exactly that. A career changer whose past life covers the new field (a nurse going into health tech) may well be a stretch, not a leap. When in doubt, it's a stretch.

**Saying it, when it's a leap.** Gently, once, with reasons. Name what the role usually needs that the profile doesn't show yet, offer a nearer step if there is one, and make clear it's their call:

> "I'll look for head of finance roles if that's what you want. I'll be honest, it may be hard: those roles usually want years running finance teams, and your profile doesn't show that yet. Something like finance systems or fintech engineering leadership would build on your billing work and get you closer. Do you want to go for head of finance anyway, try the nearer one, or both?"

Whatever they decide, go with it. Never argue twice, never refuse, never lecture. For a good fit or a stretch, say so briefly and encouragingly, and name the gaps as things to work on, not reasons to give up.

## 5. Other directions (optional)

Once their own choices are clear, you may offer, once, a direction they didn't mention that the profile backs well, with the reason: "Your team-lead years and the hiring you did would also make you a strong engineering manager candidate. Worth a search, or not for now?" Past lives count: a former mechanic might be exactly who a car maker wants. Only offer what the bank clearly supports. If they say no, drop it.

## 6. How many searches?

A search is one set of roles that share a CV, a pitch and preferences. Propose a split, explain it in a sentence, and let them decide:

- **Keep together** roles that are the same job under different names or one step apart, where the same CV and story would work: senior engineer and staff engineer; backend and platform engineer.
- **Split** when the pitch is different (the stories you'd lead with, what the employer is buying), when the preferences would differ (salary, locations), or when the fit differs a lot: CTO and software engineer; software engineer and product manager.

Name each search in their words ("Software engineering", "Engineering leadership").

## 7. Save

For each search, show exactly what you'll save (name, roles, their reasons, the fit with evidence and gaps), then on their yes:

1. `bun run ojs search add "<name>" --role "<title>" [--role …] --why "<their reason>" [--why …] --json` (it becomes the active search)
2. `bun run ojs search fit --level <good|stretch|leap> --evidence "<what backs it>" [--evidence …] --gap "<what's missing>" [--gap …] [--note "<stepping stone offered, what they decided>"] --json`

Evidence points at real things in the profile ("Checkout rebuild at Acme: led it, failed payments down 30%"). Gaps are plain and kind ("No experience managing a budget yet"). The fit is stamped with the profile's latest change, so `ojs search` and `ojs flow` can tell when it needs checking again.

To change a search's roles or reasons afterwards: `bun run ojs search correct --find "…" --replace "…" --json` (with `--search <name>` if it isn't the active one).

## 8. Finishing

When every role they want has a search with reasons and a fit, sum up in a sentence or two: the searches, and for each how strong the profile is. Ask if they're happy to move on; on a yes, `bun run ojs flow done targets --json`.

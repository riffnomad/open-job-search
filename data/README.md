# data/

What open-job-search builds. Everything in this folder except this README is ignored by git.

- `config.json`: your AI providers, shared by everyone here (no API keys; those stay in environment variables)
- `active.json`: who, and which search, you're working on (`ojs person use`, `ojs search use`)
- `<person>/`: one folder per person
  - `person.json`: their name
  - `profile/`: who they are, the same whatever they apply for
    - `profile.yaml`: details, languages, education, eligibility
    - `roles/`: one Markdown file per job, growing as you add experience
    - `past-lives/`: earlier careers and jobs outside their current field
    - `history.md`: every change to the profile, as a readable log. `ojs profile undo` reverses the latest one
    - `imports.json`: which files in `documents/<person>/` have been imported
  - `flow.json`: which steps are done
  - `searches/<search>/`: one folder per job search ("software engineering", "product management")
    - `search.yaml`: what this search is looking for: roles, locations, salary, deal-breakers, and the angle to lead with
    - `history.md`: every change to it
    - later: the jobs found and applications made for it
  - `cache/`: saved AI results, safe to delete

The files are yours to read. Every change the tool makes is logged in a `history.md` first, so nothing is lost.

Back this folder up if you care about it: it isn't in git.

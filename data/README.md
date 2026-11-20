# data/

What open-job-search builds for you. Everything in this folder except this README is ignored by git.

- `config.json`: your AI providers (no API keys; those stay in environment variables)
- `profile/`: your profile
  - `profile.yaml`: details, eligibility, preferences
  - `roles/`: one Markdown file per job, growing as you add experience
  - `past-lives/`: earlier careers and jobs outside your current field
  - `history/`: a copy of each file before the tool changed it
  - `imports.json`: which files in `documents/` have been imported
- `cache/`: saved AI results, safe to delete

The files in `profile/` are yours to read and edit. The tool only ever adds to them, and keeps a copy in `history/` first.

Back this folder up if you care about it: it isn't in git.

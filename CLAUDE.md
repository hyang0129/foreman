# Foreman

Read [AGENTS.md](AGENTS.md) before making changes. It is the single source of truth for this repo's workflow, and it applies to every agent regardless of provider.

The short version: the developer files issues as a customer, and an orchestrating agent triages the backlog, runs the work through subagents, merges, deploys, and reports what changed. Work is either a sprint or a single task. A sprint lands through an `epic/` integration branch that story branches merge into, and only the integrated epic PR targets `main` — that PR is the unit of review. A single task goes straight to `main` as one branch and PR. Never commit to `main` directly, run all five checks and report real numbers including failures, and deploy or restart the Foreman service only for merged `main`, following the rules in AGENTS.md.

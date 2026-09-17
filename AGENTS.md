# Working in this repo

## Branch and PR workflow

**Do not commit or push to `main`.** Every change — including a one-line fix, a docs edit, or a revert — goes on a branch and lands through a pull request.

1. Branch from up-to-date `main`: `git fetch origin && git switch -c <type>/<short-name> origin/main`, where `<type>` is `feat`, `fix`, `test`, `docs`, `chore`, or `refactor`.
2. Commit in reviewable increments. One concern per commit; a commit that mixes a behavior change with a large mechanical rename is hard to review and should be split.
3. Push the branch and open a PR: `gh pr create --fill` (add `--draft` while still working).
4. In the PR body, state what changed, what you verified with real results including failures, and what you could not close. If the change touches an authorization or permission boundary, say so explicitly in the first line so it gets the review it needs.
5. Link the issue the work belongs to. Do not close an issue from a commit message; let the merge do it.
6. Leave the merge decision to the developer unless they told you to merge. If you are told to merge, use `gh pr merge --squash --delete-branch` and confirm `main` is green afterwards.

A pre-push hook rejects direct pushes to `main`. If it fires, you are on the wrong branch — move your commits rather than bypassing it. `--no-verify` exists for the developer, not for agents.

## Verification before you claim anything

Run all five and report the real numbers, including failures:

```
npm test
npm run typecheck
npm run cloud:typecheck
npm run cloud:test
npm run test:ui
```

The live suites (`FOREMAN_LIVE=1`) spend real model turns and real network calls. Run them when the change affects session launch, permissions, or process lifecycle, and never as part of ordinary `npm test`.

Never describe a test as passing unless you watched it pass. A test that cannot distinguish "the mechanism worked" from "the operation never ran" is not evidence — this repo has been burned by exactly that.

## Things not to do

- Do not deploy to Cloudflare (`npm run cloud:deploy`) or restart the Foreman service. The developer does both. A daemon usually runs from this same source tree; restarting it can kill the session doing the work.
- Do not modify `package.json` or `package-lock.json` unless the task is specifically about dependencies.
- Do not touch `~/.foreman`, `wrangler.jsonc` credentials, or the `.claude` directory.
- Do not weaken a failing assertion to make a suite green. Fix the behavior, or report that you could not.

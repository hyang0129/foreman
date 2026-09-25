# Working in this repo

## Development cadence

Foreman is built in a loop between the developer and an orchestrating agent. The developer acts as a **customer**: they use the shipped app and file issues. The **orchestrator** owns delivery: it works through the backlog, ships to production, and reports what changed.

1. **The developer files issues.** Bug reports, feature requests and design direction go in GitHub issues or comments on them. A decision the developer states in a comment is settled. Agents build on it and don't reopen it.
2. **Triage.** The orchestrator reads every open issue and its comments, then proposes an order. The proposal says which issues become sprints, which are single tasks, which fold together because they change the same surface, and which are parked. A parked issue gets the `deferred` label and a comment saying why. Each open decision comes with a recommended default.
3. **Pre-execution approval.** Before any implementation starts, the orchestrator posts one **approval review** for the whole batch it plans to run, and waits for the developer's go. The review goes through each planned sprint and task and lists everything that needs a human. It includes:
   - **Scope:** what is in, what is folded together, and what is deferred.
   - **Open decisions,** each with a recommended default. For a large design question, a subagent first writes the design as a comment on the issue.
   - **Exceptions to [Things not to do](#things-not-to-do),** such as a `package.json` change or a change to `wrangler.jsonc`, credentials, or `~/.foreman`.
   - **Changes to security or permission policy,** such as a new permission mode or a new default.
   - **Hard-to-reverse actions,** such as a Durable Object migration, deleting stored data, or a relay protocol change that breaks older clients.
   - **Disruption and spend:** service restarts that may interrupt sessions, and live suites that spend real model turns.
   - **Human-only steps:** OAuth sign-ins and real-phone checks, each placed at the point in the plan where it is needed.

   The developer approves the list, possibly with changes. The orchestrator records the approved items as a comment on each affected sprint or task issue, because issues are the source of truth. From then on the batch runs unattended. Decisions the developer didn't answer take their recommended default, and the report says which defaults were taken.
4. **Execute.** The orchestrator gives each sprint to a **sprint lead**, a subagent that runs it as described in [Sprint and task workflow](#sprint-and-task-workflow). Sprints that change separate parts of the code run in parallel. A single task gets one implementer and one non-author reviewer.
5. **Land and ship.** The orchestrator, not the lead, lands each epic PR. It checks the PR on GitHub. If `main` has moved, it merges `main` in and reruns the five checks. It runs the live suites when the change calls for them. Then it merges and deploys, following [Deploying and restarting](#deploying-and-restarting). The orchestrator is the only deployer.
6. **Report, then loop.** After each ship, tell the developer what changed *for them* (not the diff), anything they need to do, and which follow-up issues were filed. Findings from reviews that don't block become new issues and return to step 2.

Rules of the loop:

- Anything that needs a human goes in the approval review, not mid-run. If something new comes up during execution that the review didn't cover, pause only the affected work, keep the rest of the batch running, and raise it in the next report. Never settle a new item like that on a default.
- Don't take a lead's report on trust. Confirm the PR's state and the exact commit the checks ran on.
- Sprint leads launch their own agents in the foreground (`run_in_background: false`). A background child does not wake a subagent lead, and the sprint stalls.
- Clean up after agents. Prune finished worktrees. Before deploying, check that no agent wrote to real state (`~/.foreman`, PM memory).

## Sprint and task workflow

Work here is either a **sprint** or a **single task**, and they land differently.

A **sprint** is a bounded, human-approved outcome made of several related stories — a tracked epic issue such as the UX polish epic. A **single task** is a genuinely isolated, low-risk change: one fix, one doc edit, one mechanical refactor.

**Never commit or push to `main` directly.** A pre-push hook rejects it.

### Sprint topology

```
main
 └── epic/<epic-issue>-<slug>        long-lived integration branch
      ├── agent/<leaf-issue>-<slug>  one story, one PR into the epic branch
      ├── agent/<leaf-issue>-<slug>
      └── ...
```

- Story branches target the **epic branch**, never `main`. Each story gets its own PR there.
- **Only the integrated epic PR targets `main`.** That PR is the unit of review. The sprint is reviewed whole, once: by the orchestrator in the [development cadence](#development-cadence), otherwise by the developer. Nobody outside the sprint reviews individual story PRs.
- Story PRs are reviewed by an agent that is **not their author**, before merging into the epic branch.
- The integrator resolves conflicts and changes integration-owned files only. A behavioral defect goes back to the story that owns it; do not fix it in the integration commit.
- After a story has merged, further repairs to it are new PRs into the epic branch. Never merge a broken epic PR and fix it on `main`.

### Decomposition

Split a sprint by **ownership seam, not by feature slice**: each story owns explicit files or directories, and two concurrent stories must not edit the same implementation file. Where stories share a contract — a schema, an API shape, shared CSS tokens — land the contract story on the epic branch *first*, before dependent stories begin.

Use a separate git worktree per concurrent agent. Never run two write-capable agents in one worktree.

### Issues are the source of truth

Every sprint and every story has its own issue before implementation starts. Do not replace an issue with a committed plan document, a PR description, or an agent conversation, and do not create `docs/` files as temporary plans, handoffs, or review ledgers.

A sprint issue states the outcome and why it matters, the scope and explicit non-goals, invariants and material decisions, shared contracts, acceptance criteria, the planned stories with their dependencies and integration order, risks and cut order, and a human QA checklist.

A story issue states one independently deliverable concern, the files it may write and what it only reads, the contracts it consumes and produces, behavior that must not change, and the condition for returning the work to the sprint.

### Single tasks

A single task goes straight to `main` as one `<type>/<short-name>` branch and PR — `feat`, `fix`, `test`, `docs`, `chore`, or `refactor`. Use `gh pr create --fill`, link the issue, and let the merge close it rather than closing it from a commit message. If you chose the single-task path for something that could have been a sprint, say why orchestration was unnecessary.

### Merging

In the [development cadence](#development-cadence), the orchestrator merges once the definition of done is met. Outside it, leave the merge decision to the developer unless they tell you otherwise. When merging: story PRs merge into the epic branch preserving their merge commits; the epic PR squash-merges into `main` with `gh pr merge --squash --delete-branch`.

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

## Definition of done

A **story** is done when its scoped behavior works, its focused tests pass, an independent non-author review has passed each applicable concern, and it changed no contract it did not own. A concern that genuinely does not apply may be marked not-applicable with a concrete reason.

A **sprint** is done when every acceptance criterion maps to a test or a review artifact, all five checks pass on the pushed epic commit, evidence identifies the exact commit it came from, known limitations and scope cuts are explicit, and `main` remains working after the merge.

The epic PR body carries the evidence the developer needs and nothing they should have to dig for: the exact head SHA, real verification numbers, what changed and what did not, known limitations, and a short human QA checklist — at most a dozen items, each with setup, action, and expected result. Do not ask the developer to inspect source, story PRs, logs, or raw artifacts to answer a checklist item.

## Deploying and restarting

Agents may deploy and restart the service, but only to ship code that has already landed.

- **Only merged `main`.** Deploy and restart only a commit that is on `main` and on which all five checks passed. Never deploy a story branch, an epic branch, or a dirty tree.
- **The service checkout.** The Foreman service runs from `/Users/hong/code/foreman`. Bring it up to date with `git pull --ff-only` on `main` only. If the tree is dirty or the pull is not a fast-forward, stop and ask the developer.
- **Restart (`npm run service:restart`).** A restart interrupts every managed session and any active PM turn. Run `npm run status` first. If sessions are working or the PM is mid-turn, ask the developer before restarting, unless they already said to restart anyway. Never restart if your own process was started by the Foreman service (a managed session or the PM): the restart kills you mid-task. Ask the developer instead. After restarting, confirm with `npm run service:status` and `npm run status`.
- **Cloud (`npm run cloud:deploy`).** The Worker serves `web/`, so web changes reach the hosted app only after this runs. The script reuses the existing pairing in `~/.foreman/cloud.json`. Never delete, rotate, or hand-edit that file or any Cloudflare secret. After deploying, confirm the hosted app loads and the host shows as connected.
- **Dev preview (`npm run dev:deploy`, `dev:start`, `dev:stop`, `dev:destroy`).** These are isolated from production and may be used whenever a task needs them.
- **Report it.** State the exact commit you deployed or restarted onto, each command's result, and what you checked afterwards, including failures.

## Feedback that is not blocking

Blocking means it fails an approved acceptance criterion. Everything else — a good idea, a nit, an adjacent bug — becomes its own issue rather than growing the current sprint. Before proposing the next sprint, review those issues and record a disposition for each: included, deferred, duplicate, or declined.

## Things not to do

- Do not modify `package.json` or `package-lock.json` unless the task is specifically about dependencies.
- Do not touch `~/.foreman`, `wrangler.jsonc` credentials, or the `.claude` directory, except through the deploy and service scripts described under [Deploying and restarting](#deploying-and-restarting).
- Do not weaken a failing assertion to make a suite green. Fix the behavior, or report that you could not. The same applies to skipping a test, raising a tolerance, updating a golden, or relaxing a budget — unless the sprint explicitly changed that expectation.
- Do not treat a passing retry as proof a flaky test is fine. Flakiness is itself a failure.
- Do not report a check as passing if it was skipped, run against a dirty tree, or run against a different commit than the one you pushed.

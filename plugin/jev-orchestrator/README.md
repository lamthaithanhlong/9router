# jev-orchestrator

DeepSeek Harness plugin. One tool, `jev_run`, runs a coding task through cost-aware roles.

| Role | Route (provider/model) | Cost | Does |
|---|---|---|---|
| worker | router9/cursor-workers | free | edits code, runs tests |
| planner, researcher | router9/codex-head (falls back to router9/manager-temp) | Codex quota | one plan per task; GitHub/docs digests |
| reviewer | deepseek-host/deepseek-v4.1-flash (falls back to Codex) | money | reviews the diff, only when a trigger fires |
| final_reviewer | router9/codex-head | Codex quota | last check before merge, only for risky diffs |
| backup (last in every chain) | router9/backup-free (a 9Router combo of free OpenCode/OpenRouter models) | free | runs a role only when the routes before it are out of budget or failing |
| yes/no decision | hosted Jev (`https://api.typesafe.ai/v1/systemone`), local `laya-serve` as fallback | 50 questions/day, then free | does an English task need a plan? (review question exists but is off by default) |

## Rules the code enforces

- The tool has no `model` parameter. A role picks its route from a chain (`lib/config.js`, `chains`), cheapest first. A role whose chain is out of budget is held for a person; it never uses a route outside its chain.
- The paid review runs only on code-computed triggers: diff over 150 lines, a risky path, a path outside `allowed_paths`, tests red twice. Laya (when its review question is switched on) can add a reason to review; it cannot remove one.
- Laya is used only for the plan question, only for English tasks, and measured zero-shot it cannot tell risky diffs from trivial ones, so `laya.reviewEnabled` is false until it is fine-tuned (see PLUGIN-TEMPLATE.md §11.5).
- The plan question can go to the hosted Jev first (`laya.url`, key from `laya.keyEnv` or the 0600 `laya.keyFile`)
  and falls back to the free local `laya-serve` (`laya.fallbackUrl`) when no key resolves or the hosted call fails.
  A cloud URL never starts the local engine; only a loopback URL may. The hosted route is capped at
  `budgets.laya` questions per UTC day (default 50, the plan's quota) — counted in CALLS, checked before the
  request. Once that quota is spent the question goes to the free local engine instead of being skipped, so
  heavy days keep working at no cost.
- Laya down means the rules alone decide, and the report says so. When the local engine is unreachable the plugin starts it in the background through `~/.local/bin/laya-ctl` (at most once per 5 minutes).
- A role moves to the next route of its chain when a route is out of budget or its child fails; the last route is always `backup`. A failed route is skipped for 10 minutes. A risky diff approved only by backup reviewers still waits for a person (`backupPolicy.reviewIsFinal`).
- At most 3 children run at once on Cursor (`cursor-workers` and `manager-temp` share that cap) and starts are 2 s apart, across all `jev_run` calls; extra sub-tasks queue, and a call with more than 6 sub-tasks or 3 research questions is refused. Tune with `limits.concurrency`, `limits.startGapMs`, `limits.maxTasks`.
- Reviewers see the plan and the diff, never the worker's own words. An unreadable verdict counts as "changes".
- Spend is counted per UTC day in `~/.dsh/jev-ledger.json`. Codex keeps 20% in reserve for the final review.

## See who ran

Every report starts with `Who ran:` (role, route, seconds, estimated tokens, Laya's answer, and the roles that were not called). Each run is also appended to `~/.dsh/jev-runs.jsonl`. `node who.mjs [N]` prints the last N runs and what 9Router itself received in the same time window, which names the real model behind a combo.

## Cursor: the app, not an API

Cursor reached through 9Router (`cu/default`) can answer an HTTP 200 whose body is only an authentication error. 9Router reads that as an empty reply, counts it as a success, and never falls to the next model of the combo. Two things follow:

- A route that answers with no text is now a **failed** route here too: the call falls to the next route on the chain and the empty route cools down (`routeCooldownMs`). Nothing is accepted as "done" with empty text any more.
- To keep a Cursor subscription that works only inside the Cursor app useful, there is a file queue (`lib/queue.js`). Put `cursorqueue` first on the worker chain:

  ```yaml
  config:
    chains:
      worker: [cursorqueue, backup]
  ```

  A worker task is written to `~/.dsh/cursor-queue/pending/`. You tell the Cursor app: *"Process the Jev queue in `~/.dsh/cursor-queue`: read README.md and follow it."* The app moves the task to `claimed/`, edits the files in `cwd`, and writes `done/<id>.md`; the pipeline then runs its tests and reviews as usual. A task nobody claims within `cursorQueue.waitMs` (5 min) is withdrawn and the backup route takes the work, so a run never waits on a person forever and the work is never done twice. To skip Cursor entirely: `chains: { worker: [backup] }`.

## Tool parameters

`task` and `cwd` are required. Optional: `tasks` (parallel workers), `research` (questions for Codex), `allowed_paths`, `test_command`, `plan` (`yes`/`no`/`auto`), `final_review`.

## Version

See `CHANGELOG.md`. The running version is the `Plugin:` line at the end of every `jev_run` report and the `version` field of each run-log line.

## Develop

From the package root: `node --test dev/test/*.test.mjs`. See `PLUGIN-TEMPLATE.md` §8 for the full checklist.

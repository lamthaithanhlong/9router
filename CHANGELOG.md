# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org), with the
single source of truth in `plugin/jev-orchestrator/package.json`. While the major version is 0, a minor bump
may change defaults or config keys; read the entry before upgrading.

How to bump (see `PLUGIN-TEMPLATE.md` §13):

- **MAJOR**: a tool parameter or config key is removed or renamed, or a default changes so that existing
  `config:` blocks mean something different.
- **MINOR**: new behaviour, new optional parameter or config key, a changed default.
- **PATCH**: bug fixes and documentation only.

## [Unreleased]

## [0.7.1] - 2026-10-07

### Fixed
- **The probe starved the answer it was asking for** (`probe.maxTokens`, `lib/probe.js`). These are
  reasoning models and the thinking tokens come out of the same `max_tokens` budget, so the original
  `max_tokens: 8` truncated the visible text: measured against the live route, 8 tokens gave `""` or
  `"P"`, while 64 gave `PONG` three times out of three (completion_tokens 33, 30, 11). The probe would
  therefore have reported a **healthy** route as dead and skipped it — worse than having no probe. The
  budget is now `probe.maxTokens` (default 256), and a test asserts it is never tightened back below 64.
- **The probe authenticated with the wrong credential** (`lib/probe.js`). `/v1/chat/completions` is
  9Router's *proxy* endpoint and answers **HTTP 401** to the dashboard's `x-9r-cli-token`; the probe
  now sends `ROUTER9_API_KEY` when the environment has it and otherwise reads the active key out of
  9Router's own `apiKeys` table. Caught by a live smoke test against the running 9Router, not by a
  stub: every probe had been reporting `HTTP 401` instead of the route's real answer, which would have
  marked a healthy route dead and skipped it.
- **`lib/cost.js` did not expand `~`**, so a caller passing the documented default
  (`~/.9router/db/data.sqlite`) opened nothing and every cost method answered zero for the whole day —
  silently, with a single log line. It now expands the path itself, as `lib/steps.js` already did.
- `dev/test/scripts.test.mjs` accepted only the literal sandbox import, so a test file that also needs
  `SANDBOX_HOME` was rejected for its shape rather than for forgetting the import.

### Measured
With all three fixes in, the live smoke test on the owner's machine reports what had only been assumed:
`probe cursor-workers -> PONG` in about 3s and `probe manager-temp -> empty reply (HTTP 200, 0 chars)`
in 240ms, the probe cache returns a second ask without a new upstream call, `cost.dayUsd()` reads the
real `usageDaily` row, and `steps.js` writes `ts,run,text,...` in the documented order.

The Cursor question itself is answered, and the answer is "sometimes": the relay returned `PONG` on
three consecutive manual calls, and `""`/`"P"` through the probe before the token budget was fixed. It
is not a route to build a run on, which is exactly why it now goes last on the worker chain and is
probed first.

## [0.7.0] - 2026-10-07

### Added
- **Real cost per call and per task, read from 9Router's `usageHistory`/`usageDaily` SQLite log** (`lib/cost.js`,
  `createCostTracker`). Before a call: `assumeUsd(routeKey)` returns `cfg.cost.assume[routeKey]` if the owner
  has set one, else the in-process rolling average (exponential, weight 0.5), else 0. After a call:
  `reconcile(watermark, { routeKey, provider, model })` sums the rows 9Router wrote during it; rows are matched
  by provider/model when both are given and at least one matches, else every post-watermark row counts (children
  run in parallel, so an unmatched row is still this run's spend). The result is charged to the per-task
  accumulator. `dayUsd()` reads `usageDaily` for today's dateKey so the report can show "today via 9Router";
  `recentCalls(limit)` lists the last N upstream calls. When 9Router is missing or `node:sqlite` is unavailable,
  every method degrades to zero / null and the plugin still runs on the rules alone.
- **`cost.callUsd` / `cost.taskUsd` caps that apply only to `cost === "money"` routes** (the owner's `mvn/*`
  DeepSeek-Host routes; their per-token charges are the real spend). The recorded cost for every other route is
  9Router's list price, not money leaving the account: `cu/*`, `oc/*`, `cx/*` and `jg/*` are free or subscription
  relays and must never be throttled by it. So when a money route would exceed `callUsd` the pipeline walks the
  chain as usual (try the next affordable route, and on reaching the end, hold the role for a person), and when
  `taskUsd + assume > taskUsd` it stops the whole run with `awaiting_human` and the reason
  `cost: task budget $X exceeded (spent $Y, this call ~$Z)`. `enforce: false` keeps both checks as warnings.
- **A free live step stream** (`lib/steps.js`, `createSteps`, `~/.dsh/jev-steps.jsonl`). One JSON line per
  transition: `run started`, `worker-1 started on cursor-workers`, `worker-1 done in 12.5s, $0.0011`,
  `tests: exit 1 (red)`, `gate: diff 210 lines > 150 -> review`, `reviewer verdict: changes (2 reasons)`,
  `fix round 1/2`, `run done: $0.1904, 34 calls`. The `run` key is `Date.now().toString(36)` so every line of
  one run shares it. `mkdirSync` first, `appendFileSync`, swallow and log once on write failure: a full disk
  must not kill a run.
- **`watch.mjs` fix and step source.** `watch.mjs` previously read tokens from `requestDetails.data.tokens`,
  but streaming rows record `{"prompt_tokens":0,"completion_tokens":0}` there — the real numbers and the
  dollar cost live in `usageHistory` (`promptTokens`, `completionTokens`, `cost`). It now reads tokens and
  dollars only from `usageHistory` and keeps `requestDetails` only for latency/status (which the live view
  does not use), with a running `$` total. It also tails the new step feed by byte offset, printing
  `HH:MM:SS  step   <text>` exactly like it already does for `jev-runs.jsonl`.
- **`jev_watch` tool** — a second, read-only companion tool next to `jev_run`. Optional `lines` (default 30).
  Returns plain text: the last `lines` entries from `~/.dsh/jev-steps.jsonl`, today's spend from
  `usageDaily`, the last 10 upstream calls from `usageHistory`, and the current ledger contents. It performs
  no model call and no subagent call — only file reads and the read-only SQLite handle — so checking
  progress costs nothing. Registered only when `cfg.cost.enabled`.
- **`jev_probe` tool** — one call that answers "is that route actually returning anything?". It asks every
  route marked `probe: true` and prints a table of route / model / cost / alive / ms / sample. It shares the
  cached probe with the pipeline, so running `jev_probe` just before a `jev_run` makes that run's own probes
  free. No subagent is started.
- **A probe before a flaky route is committed to a child** (`lib/probe.js`, `createProbe`). The Cursor route
  can answer HTTP 200 with no text — an `ERROR_NOT_LOGGED_IN` carried inside the stream, which 9Router records
  as `[Empty streaming response]` and counts as a success. The pipeline already treated an empty reply as a
  failed route, but only after the child had waited: the run log shows `worker-1 ended with aborted` after
  1638s. Now a route flagged `probe: true` (cursor, manager) is asked first with a 15s timeout and must return
  the literal `PONG`; a route that does not is skipped, put into the same cooldown as a real failure, and
  written to the step feed as `probe cursor-workers: empty reply (HTTP 200, 0 chars) - skipped`. Routes that
  answer when they answer (codex, deepseek, backup) are never probed: that would spend quota or money to learn
  nothing. One probe is one small upstream call, not an agent.
- **A cross-check before a diff is accepted** (`review.crossCheck`, `review.onDisagree`). After the primary
  reviewer approves, each named route reads the same plan and diff and gives its own verdict; the report shows
  them side by side (`review cross-check: codex-head -> approve | deepseek-v4.1-flash -> changes`) and a split
  verdict goes to a person instead of being settled by whichever reviewer ran first. A second opinion that
  could not be obtained (route out of budget, probe failed) is reported as `unavailable`, never as a
  disagreement. Empty by default.

### Changed
- **Roles follow strength rather than price.** `chains` now defaults to
  `planner/researcher: [codex, deepseek, backup]` (codex researches best), `worker: [deepseek, cursor, backup]`
  (deepseek writes code and reasons about the system; Cursor is a last resort because of the empty-200 bug) and
  `reviewer/final_reviewer: [codex, deepseek, backup]`.
- `formatReport` gains a `Cost:` section, printed even when nothing was spent:
  `Cost: $0.1904 this task (task cap $0.08, call cap $0.001)` / `$6.7086 today via 9Router, 200 calls`
  (or `today: n/a` when 9Router is unreadable). The `Who ran:` block is unchanged.

## [0.6.5] - 2026-10-07

### Added
- **`watch.mjs` - a live, free view of a run.** It tails 9Router's request log (every child call with latency,
  tokens and status), the ledger (the day's spend per route) and `jev-runs.jsonl` (finished runs). All three are
  written by tools that ran anyway, so watching costs no model call and no quota: `node watch.mjs` to follow,
  `--once` for the recent history.

### Changed
- **The hosted-question cap is now 70 per UTC day** (the owner's number) instead of 50.
- **A hosted "out of quota" answer marks the route spent for the rest of the UTC day.** The ledger cap can only
  estimate a plan; when the plan stops earlier, `isQuotaError` (402/429, or a quota/balance/credit message) trips
  a circuit breaker in `lib/laya.js` and every later question goes straight to the free local engine. One failed
  round-trip per day instead of one per question. A new UTC day restores the hosted attempt.

## [0.6.4] - 2026-10-07

### Changed
- **When the day's hosted-quota is spent the free local engine answers the question instead of the run losing
  it.** `budgets.laya` still caps the *hosted* questions at 50 per UTC day, but the 51st question is now put to
  `laya.fallbackUrl` (`opts.cloud === false`, `source: local`) rather than skipped, so a day with heavy use
  keeps its Jev answer at no cost. Only hosted answers are charged.

## [0.6.3] - 2026-10-07

### Changed
- **The Jev cap is counted in questions, not tokens.** The plan that serves this key allows **50 questions per
  UTC day**, and that quota — not the money ($0.042 per million input tokens) — is the scarce resource. With the
  old 2M-token cap the plugin would have burned a whole day's quota before the ledger noticed. `budgets.laya` is
  now `{ unit: "calls", daily: 50 }`, checked before the request.
- **Only a hosted answer is charged.** The free local `laya-serve` fallback no longer consumes quota, and the
  trace records which source answered (`source: cloud|local`).

## [0.6.2] - 2026-10-07

### Added
- **Hosted Jev (TypeSafe) as the primary System One source**: `laya.url`, `laya.keyEnv`, `laya.keyFile` and
  `laya.model`, with the free local `laya-serve` kept as `laya.fallbackUrl`. Measured on a real plan
  question: the hosted model answers in **0.25 s** against **12.2 s** for the local engine, at
  **321 input tokens** (Jev 1.13 is $0.042 per million input tokens, output free). A cloud URL never
  spawns `laya-ctl`: only a loopback URL may start the local engine.
- **A key file as a credential source** (`lib/keys.js`, shared by Laya and the API routes): the
  environment wins when set, a `0600` file is the fallback. DSH resolves `$DSH_HOME/.credentials.yaml`
  per request for its own adapters but does **not** export it into `process.env`, so plugin code reading
  only `process.env[keyEnv]` could never see such a key.
- **A daily input-token cap on the Jev route** (`budgets.laya`, default 2 000 000 ≈ $0.084/day at Jev 1.13
  pricing). It is checked *before* the call and the real usage is charged afterwards, so a runaway loop
  stops instead of spending.

### Fixed
- `lib/api.js` accepts `keyFile` as well as `keyEnv`, and an injectable `readFile` for tests.

## [0.6.1] - 2026-10-07

### Added
- **HTTP API routes for the text-only roles** (`lib/api.js`, routes `api_deepseek` and `api_openrouter`).
  An OpenAI-compatible POST carries the role's prompt; the reply text and the upstream usage counts are
  used directly. The API key travels in the request header only and never appears in an error, trace or
  log line (errors name the env var, never its value). No retries inside `api.js`: the pipeline walks
  the chain as usual, so a missing key or a failed call falls back to the next route.
- Config keys `api.enabled` (default `false`; opt-in inserts the api routes directly before `"backup"`
  in the four text-only chains — planner, researcher, reviewer, final_reviewer — while the worker chain
  stays untouched), `limits.apiTimeoutMs` (default 300_000), and placeholder daily token caps per api
  route (`unit: "tokens"`; tune to the real upstream quota, the numbers are only a safety net).
- `deps.spawn` may resolve to `{ text, tokensIn, tokensOut }`; the pipeline charges the real counts
  and records them on the trace entry, and keeps the estimate path for strings, failures, and absent usage.

## [0.6.0] - 2026-10-07

### Added
- **A file queue to the Cursor app** (`lib/queue.js`, route `cursorqueue`). Cursor reached through 9Router cannot be
  used (below), but a Cursor subscription works inside the app. A worker task is written to
  `~/.dsh/cursor-queue/pending/<id>.md`; a person tells the app to process the queue (the protocol is in a
  `README.md` the plugin writes into that folder); the app moves the task to `claimed/`, edits the files in `cwd`
  and writes `done/<id>.md`; the pipeline then runs its tests and reviews as usual. A task nobody claims within
  `cursorQueue.waitMs` (5 min) is withdrawn to `expired/` and the next route on the chain takes the work, so a run
  never waits on a person forever and the work is never done twice. A claimed task may take up to
  `cursorQueue.claimedWaitMs` (30 min). The route is on **no** chain by default; enable it with
  `chains: { worker: [cursorqueue, backup] }`.
- Config keys `cursorQueue` (`dir`, `waitMs`, `claimedWaitMs`, `pollMs`, `settleMs`) and, for the `cursorqueue` group,
  `limits.concurrency` 3 and `limits.startGapMs` 0.

### Changed
- **A route that answers with no text is now a failed route**, for every role. Before, an empty answer counted as a
  success, so the run carried on with empty text and no fallback ran. The failed route cools down like any other
  (`routeCooldownMs`).

### Found (measured, not fixed here)
- **Cursor through 9Router answers every request with `ERROR_NOT_LOGGED_IN` inside an HTTP 200 stream.** 9Router
  does not read that error: it records an empty reply and counts the model as having succeeded, so a combo with
  `cu/default` first never falls to the next model. `manager-temp` and `main` both start with `cu/default`, which
  is why the head agent got empty replies on the default model. The same request, byte-identical to 9Router's
  (checked against its own encoder), gets the same error direct, through the Cursor-app proxy, with another client
  version and on the newer agent endpoint. The token in the Cursor app is a local placeholder; the service swaps it
  for a real one only for the app's own traffic. Fix on the 9Router side: put the `cu/*` models last in
  `manager-temp` and `main` (PLUGIN-TEMPLATE.md §11.10). Not worked around in code.

## [0.5.2] - 2026-10-07

The documented, tested version of the hotfix below.

### Fixed
- **Every `jev_run` died on the desktop profile, from 0.3.0 on.** The child's tool filter named `subagent`,
  `subagent_fork` and `workflow`. In the desktop profile those live on the child's own layer, where a filter may
  not name them, so `tools.restrict()` threw `names unknown global tool "subagent"`, the child never started, and
  both the primary and the backup route failed within 2-3 ms (`awaiting_human`). The headless profile that
  `dev/e2e/` runs registers those tools globally, so the end-to-end check passed. Found by a real run in the
  desktop Harness, and first patched in place by the agent inside it (see 0.5.1).
- The plugin now reads the refused names from the Harness's own error, drops them from the filter, starts the
  child again, and remembers the refusal for the rest of the process. The report gets a note when a name was
  dropped, so a weaker filter is visible: `jev_run`, `write` and `edit` are global tools and stay denied; the
  depth limit still stops a child from delegating.
- The refusal memory lives on the plugin instance, not in module state, so it cannot leak between runs or tests.
- **Race in the first version of the fix:** when several workers start together, a sibling may already have learned
  the refused name, and the later workers (refused with the old filter) were not retried: they failed on Cursor and
  fell to the backup route. The retry now learns from the filter that attempt actually sent.

### Added
- End-to-end scenario F: the filter names a tool that does not exist, which makes the real Harness raise the same
  refusal; the worker must still start and the report must carry the note.

## [0.5.1] - 2026-10-07 (not released; patched in place)

Never built from this repository. The agent inside the desktop Harness edited `index.js` of the installed copy and
set its version to `0.5.1` after the failure described under 0.5.2. Same idea as 0.5.2 (read the refused names from
the error, drop them, retry), but the refusal memory was module state, only the log mentioned it, the concurrent
retry race was present, and nothing tested it. Replaced by 0.5.2: installing 0.5.2 overwrites that copy.

## [0.5.0] - 2026-10-07

Cursor rate-limited the owner. The cause on the plugin side was that the number of parallel workers had no cap:
a call with N sub-tasks started N children at once.

### Added
- **Per-upstream concurrency cap, shared by every `jev_run` in the process** (`limits.concurrency`). Cursor is
  capped at **3** children at once; `cursor-workers` and `manager-temp` are both Cursor and share that cap
  (`routes.*.group`). Codex and DeepSeek 2, backup 2. Children over the cap queue; they are never refused.
- **Start spacing** (`limits.startGapMs`): at least 2 s between two Cursor child starts, so a burst is spread out.
- **Fan-out limits** (`limits.maxTasks` 6, `limits.maxResearch` 3): a call above them is refused before anything
  starts, with a message telling the model to split the work.
- Queue time shows in the report: `worker-3 -> ... (queued 4.2s)`.
- The tool description tells the model about the cap.
- End-to-end scenario E (five sub-tasks, at most 3 in flight on Cursor, still parallel) and `PLUGIN-TEMPLATE.md` §11.9
  (final state of the 9Router combos, the `Combo Round Robin` finding, the `full` -> `main` rename).

### Changed
- Default behaviour: a call with more than 3 sub-tasks now runs them in waves of 3 instead of all at once.
  Set `limits.concurrency.cursor` higher in `config:` to undo that.

## [0.4.0] - 2026-10-06

Needs a `backup-free` combo in 9Router and `- id: backup-free` under the `router9` models of the Harness
profile (see `PLUGIN-TEMPLATE.md` section 11.8). Without them the backup route fails and a role whose primary
routes are out of quota is held for a person, as in 0.3.0.

### Added
- **Backup tier.** Every role's chain now ends with `backup` (`router9/backup-free`, a 9Router combo of free
  OpenCode and OpenRouter models). It runs only when the routes before it are out of budget or failing.
- **Run-time fallback.** When a child on one route fails (quota error, HTTP error, abnormal stop), the same role
  moves to the next route of its chain within the same call. A cancelled run does not fall back.
- **Route cooldown** (`limits.routeCooldownMs`, default 10 minutes): a route that just failed is skipped by later
  calls, so they go straight to the next route. A success clears it at once.
- `backupPolicy.reviewIsFinal` (default `false`): a diff that triggered review and was approved only by backup
  reviewers ends `awaiting_human` with a note. A rejection by a backup reviewer always stops for a person.
- Report and run log: `[backup, fallback]` tags, `FAILED (reason)` per attempt, and a note
  `<role> ran on the BACKUP route`.
- End-to-end scenarios C (Cursor out of quota: the worker falls back) and D (DeepSeek and Codex out of quota:
  reviewers run on the backup route and the run stops for a person), including a check that a failed route is
  not retried in the same run.

### Changed
- Chains end with `backup`. In 0.3.0 a role whose chain was exhausted was held for a person; now it runs on the
  backup route. A failed child no longer ends the role while another route is left. Review by a backup model
  alone no longer closes a risky diff (see `backupPolicy` above).
- A cancel while workers run now stops the whole run with `run cancelled` instead of ending `awaiting_human`.

## [0.3.0] - 2026-10-06

### Added
- `Who ran:` section at the top of every `jev_run` report (role, route, seconds, estimated tokens, Laya's
  answer, and the roles that were not called), and a `Plugin: jev-orchestrator <version>` footer.
- Run log `~/.dsh/jev-runs.jsonl`: one line per run, failures included, with the plugin version. `who.mjs`
  prints the last N runs and what 9Router itself received during each run.
- `childTools` config: a child agent is never offered `jev_run`, `subagent`, `subagent_fork` or `workflow`;
  roles other than worker also lose `write` and `edit`.
- `dev/e2e/`: end-to-end check inside the real Harness runtime with a fake model server (no keys, no quota).
- `dev/build.sh`: builds `jev-orchestrator-plugin-<version>.zip`, refusing when the changelog or tests disagree.
- `version` export, version shown by `install.sh` (`0.2.0 -> 0.3.0`), this changelog.
- `PLUGIN-TEMPLATE.md` §12 (end-to-end check) and §13 (versioning).

### Changed
- The worker prompt says its shell does not start in `cwd` and to run `cd <cwd> && <command>`. Measured in the
  real Harness: a child starts in the head agent's directory.

### Fixed
- Laya keepalive job: launchd killed Laya when the job exited. The plist now sets `AbandonProcessGroup`.
- `who.mjs` printed nothing when started through a symlinked path (macOS `/tmp`).
- `uninstall.sh` could remove a LaunchAgent that belongs to another Harness home. It now removes only the job
  that runs its own `DSH_HOME` script. `JEV_SKIP_LAUNCHCTL=1` keeps install/uninstall away from launchd.
- The test suite wrote into the real `~/.dsh`. Tests now run in a sandbox `HOME` with a stub `launchctl`.

## [0.2.0] - 2026-10-06

First Harness-native version, and the first one installed in a Harness profile. It replaced an earlier
TypeScript prototype that assumed Laya was a chat model (never shipped). Builds made between 0.2.0 and 0.3.0
all carried the string `0.2.0`; this entry describes the first of them.

### Added
- Tool `jev_run`: one coding task through roles (planner, researcher, worker, reviewer, final reviewer). A role
  picks its route from a chain, cheapest first; an exhausted chain is held for a person.
- Daily budgets per route (Codex calls, DeepSeek tokens) in `~/.dsh/jev-ledger.json`; Codex keeps a reserve
  for the final review.
- Review triggers computed by code (diff size, risky path, outside `allowed_paths`, tests red twice). Reviewers
  see the plan and the diff only; an unreadable verdict counts as "changes".
- Laya (System One, `127.0.0.1:8130`): used for the plan question on English tasks only. The review question is
  off by default because zero-shot it did not separate risky from trivial diffs. Laya down means the rules
  decide, and the plugin starts Laya in the background.
- `install.sh` / `uninstall.sh` (marked block, backup, idempotent, byte-for-byte uninstall), optional
  `--keepalive` LaunchAgent, `PLUGIN-TEMPLATE.md` including §11 (system setup).

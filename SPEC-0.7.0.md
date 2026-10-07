# SPEC 0.7.0 — dollar cost control + free live progress

Implement exactly what is written here. Do not rename anything, do not add npm
dependencies, do not change `dev/build.sh`. Keep every existing test green.

Repo layout you are working in:

```
plugin/jev-orchestrator/index.js        tool registration + child spawn
plugin/jev-orchestrator/lib/*.js        pipeline, budget, config, ...
plugin/jev-orchestrator/watch.mjs       standalone free viewer (node watch.mjs)
plugin/jev-orchestrator/package.json    version 0.6.5 -> 0.7.0
dev/test/*.test.mjs                     node --test, 161 tests currently pass
CHANGELOG.md                            build.sh refuses to build without an entry
```

## Why, in one paragraph (context you need)

The owner wants three things from this plugin: see what every child call costs,
stop spending past a per-call and a per-task cap, and watch the children work
without paying for a model call just to ask.

9Router records a cost for every upstream call. Two of them look big: the worker
route (`router9/cursor-workers`, resolved by 9Router to `jg/claude-sonnet-5`)
measures **$0.0335 per call** at ~75k prompt tokens and 200 calls per run —
**$6.71 per run**; the reviewer (`deepseek-host/deepseek-v4.1-flash`) measures
**$0.00011 per call**.

Those worker numbers are **9Router's list price, not money leaving the account**.
`jg/*` is the owner's local ShareAI relay (`http://127.0.0.1:20129/v1`, a shim in
front of the Cursor app's helper) and is not billed per token; `cu/*`, `cx/*` and
`oc/*` are subscription or free namespaces for the same reason. The routes that
really bill are the `openai-compatible` nodes the owner added — `mvn/*`
(DeepSeek-Host) and `jg/*` only if it ever stops being a relay.

So the plugin must never present a list price as spend. It reports what 9Router
recorded, labels where the number came from, and lets the cap be configured per
route, so an expensive-but-free subscription route is not throttled while a real
per-token route is.

Two hard facts that shape the design:

- **9Router already computes the real cost.** Its SQLite database at
  `~/.9router/db/data.sqlite` has `usageHistory` with one row per upstream call:
  `id, timestamp, provider, model, promptTokens, completionTokens, cost, tokens`
  where `tokens` is a JSON string and `cost` is USD as a float. `usageDaily` has
  `dateKey` and a JSON `data` column with `{requests, promptTokens,
  completionTokens, cost, byProvider:{...}}`.
- **`cost` cannot be computed up front.** The price table lives in 9Router's code
  (`MODEL_PRICING`), and `GET /api/pricing` only returns the per-provider
  overrides — it does not contain canonical model prices. So: estimate before a
  call from what was measured before, and **true-up after the call from
  `usageHistory.cost`**, which is exact.

## Part A — money

### A1. New file `plugin/jev-orchestrator/lib/cost.js`

```js
export function createCostTracker(cfg, { log = () => {} } = {}) { /* ... */ }
```

Returns an object with exactly these methods:

- `snapshot()` -> number
  Highest `usageHistory.id` currently in the DB, or `-1` when the DB cannot be
  read. Used as a watermark before a call.

- `async reconcile(sinceId, { routeKey, provider, model })` -> `{ usd, calls }`
  Reads `usageHistory` rows with `id > sinceId`, sums `cost`, and also returns how
  many rows were seen. Rows are matched to this call by `provider`/`model` when
  both are given and at least one row matches; otherwise every row after the
  watermark counts (children run in parallel, so an unmatched row is still this
  run's spend). Never throws: on any error return `{ usd: 0, calls: 0 }` and log
  once.
  - In-process, remember the last observed USD-per-call for `routeKey` (exponential
    average, weight 0.5) so `assumeUsd` improves during a run.

- `assumeUsd(routeKey)` -> number
  Before a call. Returns, in this order of preference: `cfg.cost.assume[routeKey]`
  if configured, else the rolling average learned above, else `0`.

- `chargeTaskUsd(usd)` / `taskUsd()` -> number
  Accumulator for the current `jev_run` call. `taskUsd()` returns the total.

- `async dayUsd()` -> `{ dateKey, usd, requests } | null`
  Today's row from `usageDaily` (`dateKey` is `new Date().toISOString().slice(0,10)`).
  This is the number the owner actually cares about. `null` when unreadable.

- `async recentCalls(limit = 10)` -> array of
  `{ timestamp, provider, model, promptTokens, completionTokens, cost }`.

Use **`node:sqlite`'s `DatabaseSync`** with `{ readOnly: true }`, exactly like
`watch.mjs` already does. Resolve the DB path from `cfg.cost.dbFile`
(default `~/.9router/db/data.sqlite`, `~` expanded by the caller). If
`node:sqlite` is unavailable or the file is missing, every method must degrade to
the zero/`null` answers above — this plugin must keep working on a machine
without 9Router.

### A2. New config block in `lib/config.js` (`DEFAULTS.cost`)

```js
cost: {
  enabled: true,
  dbFile: "~/.9router/db/data.sqlite",
  callUsd: 0.001,   // cap for ONE child call
  taskUsd: 0.08,    // cap for ONE jev_run, all roles, all calls
  enforce: true,    // false = warn only, never refuse
  assume: {},       // { routeKey: usdPerCall } manual override, wins over the rolling average
},
```

**The caps only apply to routes that really bill.** A route object already carries
`cost`: `"money"` (a per-token API), `"quota"` (a subscription quota) or `"free"`.
Only `cost === "money"` routes are refused when over a cap. Every route is still
measured, reported and written to the step feed, because the owner wants to see
the numbers — but a free or quota route must never be throttled by a list price.

`resolveConfig` already deep-merges plain objects, so nothing else is needed
there. Document each key with a short comment in the style of the file.

### A3. Caps in the pipeline

In `lib/pipeline.js`, every place that is about to start a child (the planner,
each researcher, each worker, each reviewer, final reviewer, each fix round):

1. `assume = cost.assumeUsd(route.key)`.
2. If `cfg.cost.enabled && cfg.cost.enforce && route.cost === "money"`:
   - `assume > cfg.cost.callUsd` -> do **not** start it on this route: treat the
     route as over-budget, try the next affordable route on the chain, and if none
     remains push a note and hold the role (existing `kind: "hold"` path).
   - `cost.taskUsd() + assume > cfg.cost.taskUsd` -> stop the run: no further
     child calls. Return the existing `awaiting_human` status with the reason
     `cost: task budget $X exceeded (spent $Y, this call ~$Z)`.
3. After the call returns (success **or** failure): `await cost.reconcile(...)`
   with the watermark taken in step 1, then `cost.chargeTaskUsd(usd)` and
   `appendStep(...)` a line with the real number.

The `deps` object already passed into `runPipeline` must carry the cost tracker;
add `cost` to it in `index.js` next to `ledger`.

### A4. The report must show money

`formatReport` gains a `Cost:` section, printed even when nothing was spent:

```
Cost: $0.1904 this task (task cap $0.08, call cap $0.001)
      $6.7086 today via 9Router, 200 calls
```

Numbers: `this task` = `cost.taskUsd()`, `today` = `dayUsd()`. When the day is
unreadable print `today: n/a`. Keep the existing `Who ran:` block unchanged.

## Part B — seeing what the children do, for free

### B1. New file `plugin/jev-orchestrator/lib/steps.js`

```js
export function createSteps(cfg, { log = () => {} } = {}) {
  // returns { step(text, extra = {}) }
}
```

`step()` appends ONE line of JSON to `~/.dsh/jev-steps.jsonl`
(config key `cfg.stepsFile`, default `~/.dsh/jev-steps.jsonl`, `~` expanded):

```json
{"ts":"2026-10-07T16:20:01.123Z","run":"<runId>","text":"worker-1 started on cursor-workers","role":"worker","label":"worker-1","route":"cursor","model":"cursor-workers","usd":0.0012,"taskUsd":0.0034}
```

- `run` comes from the run id: add a `runId` field to the deps (in `index.js`,
  `Date.now().toString(36)`), so every line of one run shares it.
- Append with `appendFileSync`, `mkdirSync` first. **Never throw** — a full disk
  must not kill a run; swallow and log once.

Where to call it: at every pipeline transition, with a short human phrase that a
person can read without context, for example:

- `laya: needs_plan -> 0.89 (cloud)`
- `plan: skipped (rules say a one-line change)`
- `research: 2 questions`
- `worker-1 started on cursor-workers`
- `worker-1 done in 12.5s, $0.0011`
- `tests: exit 1 (red)`
- `gate: diff 210 lines > 150 -> review`
- `reviewer started on codex-head`
- `reviewer verdict: changes (2 reasons)`
- `fix round 1/2`
- `run done: $0.1904, 34 calls`

### B2. `watch.mjs` — two changes

1. **Fix a real bug.** It reads token counts from `requestDetails.data.tokens`,
   but for streaming calls 9Router writes `{"prompt_tokens":0,"completion_tokens":0}`
   and `"[Streaming - raw response not captured]"`. The real numbers, and the
   dollar cost, are in `usageHistory` (`promptTokens`, `completionTokens`, `cost`).
   Read tokens and `$` from `usageHistory`; keep `requestDetails` only for
   latency/status. Add a running `$` total line.
2. **Add the steps file as a fourth source**, polling it by byte offset like it
   already does for `jev-runs.jsonl`, printing
   `HH:MM:SS  step   <text>`.

### B3. New tool `jev_watch` in `index.js`

Register a second, read-only tool next to `jev_run`:

- name `jev_watch`, no required parameters, optional `lines` (number, default 30).
- Returns a plain text block:
  - the last `lines` entries of `~/.dsh/jev-steps.jsonl` (already formatted);
  - today's spend from `usageDaily` and the last 10 calls from `usageHistory`;
  - the current ledger contents.
- It performs **no model call and no subagent call** — it only reads files and the
  read-only SQLite handle. That is the whole point: the owner can check progress
  for free.
- Register it only when `cfg.cost.enabled`.

## Part D — the Cursor question, answered by codex and deepseek

Background the owner measured: the `cursor` route (`router9/cursor-workers`,
resolved to `jg/claude-sonnet-5`) can answer **HTTP 200 with no text at all**, an
`ERROR_NOT_LOGGED_IN` carried inside the stream. 9Router records it as
`[Empty streaming response]` and calls it a success. The plugin already treats an
empty reply as a failed route, but a child still waits ~70 s before that verdict
(observed: `worker-1 ended with aborted` after 1638 s), and the `backup` route
that follows returns 14-16 tokens, which is useless. So the answer to "does Cursor
return anything?" must be obtained **before** a child is committed to it, and the
work must not depend on Cursor at all.

### D1. New file `plugin/jev-orchestrator/lib/probe.js`

```js
export function createProbe(cfg, { log = () => {} } = {}) {
  // returns { probe(routeKey) }
}
```

`probe(routeKey)` -> `{ ok, ms, chars, sample, reason, at }`.

- One direct HTTP `POST` to `cfg.probe.baseUrl` + `/v1/chat/completions`
  (default baseUrl `http://127.0.0.1:20128`), body
  `{"model": <the route's 9Router model>, "messages":[{"role":"user","content":"Reply with the single word: PONG"}], "max_tokens":8, "stream":false}`.
- Auth: `Authorization: Bearer ${process.env.ROUTER9_API_KEY}` when that variable
  is set, otherwise `x-9r-cli-token: <same token watch/cost use>`.
- `AbortSignal.timeout(cfg.probe.timeoutMs)` (default `15000`).
- **`ok` is true only when the reply text matches `/PONG/i`.** A 200 with empty
  or unrelated text is a failure — that is the whole point, since 9Router reports
  the empty case as success.
- Per-route cache for `cfg.probe.ttlMs` (default `300000`); a failed probe also
  puts the route into the existing `RouteHealth` cooldown.
- Never throws: any error becomes `{ ok: false, reason }`.
- Config block:

  ```js
  probe: { enabled: true, baseUrl: "http://127.0.0.1:20128", timeoutMs: 15000, ttlMs: 300000 },
  ```

- Mark the routes that need it, in `DEFAULTS.routes`: `cursor` and `manager` get
  `probe: true`. Nothing else does — codex, deepseek and backup answer when they
  answer, and a probe on them would cost quota or money for no information.

### D2. The pipeline asks before it commits a child

In `lib/pipeline.js`, before starting a child on a route whose definition has
`probe: true`: call `probe(route.key)`. When `ok` is false, treat the route as
cooling, take the next affordable route on the chain, and write a step line such
as `probe cursor-workers: empty reply (200, 0 chars) - skipped, cooled 10m`.
When every route on the chain is out, the existing hold path reports it. With
Part A's cost caps this means a `jev_run` can no longer spend 27 minutes waiting
for a route that was never going to answer.

### D3. Cross-check — "both of them look and report"

New config:

```js
review: { crossCheck: ["codex", "deepseek"], onDisagree: "awaiting_human" },
```

After the primary reviewer returns a verdict, if `crossCheck` is non-empty run the
**other** named routes as second opinions on the same plan + diff. Each verdict is
recorded in the trace with its route key and shown in the report as

```
Review: codex-head -> approve (1 note) | deepseek-v4.1-flash -> changes (2 notes) -> DISAGREE
```

`awaiting_human` is forced on disagreement when `onDisagree` says so; a diff is
never merged on a split verdict. A second opinion that could not be obtained
(route out of budget, probe failed) is reported as `unavailable`, not as a
disagreement.

### D4. One tool call to run the whole check

Register `jev_probe` next to `jev_run`, taking no parameters. It probes every
route that appears on any chain and prints one table:

```
route          model                    cost    alive   ms     sample
codex          codex-head               quota   yes     812    PONG
deepseek       deepseek-v4.1-flash      money   yes     640    PONG
cursor         cursor-workers           free    NO      2210   "" (empty 200)
backup         backup-free              free    yes     1990   PONG
```

It uses the same cached `probe()` as the pipeline, so a `jev_probe` immediately
before a `jev_run` makes the run's own probes free. This is the single call that
answers "thằng cursor có trả về không".

### D5. Reporting stays free

Every probe result, every cap decision and every review verdict goes through
Part B's `step()` feed, so `jev_watch` and `watch.mjs` show it without a model
call. That is what the owner reads to decide whether to loosen a permission.

## Part C — version, changelog, tests

- `plugin/jev-orchestrator/package.json`: version `0.7.0`.
- `CHANGELOG.md`: add, immediately above the current newest entry,

  ```markdown
  ## [0.7.0] - 2026-10-07
  ```

  followed by bullets describing: real cost per call and per task read from
  9Router's `usageHistory`/`usageDaily`; `cost.callUsd` / `cost.taskUsd` caps that
  apply only to `cost: "money"` routes; the free step feed; the `watch.mjs` fix;
  the `jev_watch` tool. Say in the entry that the recorded cost is 9Router's
  number and that a free or subscription route is measured but never throttled.

- New tests in `dev/test/` — read an existing test file first and follow its
  style exactly (`dev/test/_sandbox.mjs` shows how tests build a temp home). Add:
  - `cost.test.mjs`: a temp SQLite file (create it with `node:sqlite`) holding a
    few `usageHistory` and one `usageDaily` row; assert `assumeUsd` precedence
    (config override beats rolling average), `reconcile` sums only rows after the
    watermark, `taskUsd()` accumulates, and every method returns the zero value
    when the DB file does not exist.
  - `steps.test.mjs`: `step()` appends valid JSON lines with `run`, `text` and
    `ts`, and does not throw when the target directory cannot be created.
  - extend `pipeline.test.mjs`: with `cost.taskUsd` tiny, a run ends
    `awaiting_human` with a reason containing `cost:` and starts no further
    child; with `cost.callUsd` tiny, a role falls to the next route on its chain
    instead of using the over-cap one.
  - `probe.test.mjs`: a stubbed fetch that returns `PONG` gives `ok: true`; a 200
    with `""` gives `ok: false` with a reason naming the empty reply; a request
    that never resolves becomes `ok: false` at the timeout; a second `probe()` of
    the same route within `ttlMs` performs no second HTTP call; a failed probe
    makes the next route selection skip that route.
  - extend `pipeline.test.mjs` for Part D: a worker chain whose first route probes
    dead starts its child on the second route, and the run's trace records the
    `unavailable`/skipped route; with `review.crossCheck` naming two routes, both
    verdicts appear in the report, and a split verdict yields `awaiting_human`.

## Definition of done

1. `node --test dev/test/*.test.mjs` — all pass, count strictly greater than 161.
2. `bash dev/build.sh` succeeds and prints a `sha256`.
3. `grep -n "0.7.0" plugin/jev-orchestrator/package.json CHANGELOG.md` shows both.
4. No new entry in `dependencies`/`devDependencies` anywhere.
5. `watch.mjs` reads no token or cost value from `requestDetails`.
6. `worker` never starts a child on a route whose `probe` is `true` and whose
   probe did not answer `PONG` inside `probe.timeoutMs`.

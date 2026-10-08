# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org), with the
single source of truth in `plugin/david-plugin/package.json`. While the major version is 0, a minor bump
may change defaults or config keys; read the entry before upgrading.

How to bump (see `PLUGIN-TEMPLATE.md` §13):

- **MAJOR**: a tool parameter or config key is removed or renamed, or a default changes so that existing
  `config:` blocks mean something different.
- **MINOR**: new behaviour, new optional parameter or config key, a changed default.
- **PATCH**: bug fixes and documentation only.

## [Unreleased]

## [0.13.0] - 2026-10-07

### Fixed
- **A worker answered "Blocked" and the run was reported `done`.** Putting Codex first in the worker chain showed it: a rule written for
  the agent that CALLS david ("every change goes through david_run") sits in `AGENTS.md` and in the system prompt, so the agents
  david starts see it too. Codex read it literally, noticed it had no `david_run`, wrote "Blocked: repository changes require
  david_run" and changed nothing; DeepSeek workers had simply ignored the rule. What actually stopped it was the rule in the
  **system prompt** (it called it "developer policy"; the section `david-force` adds applies to every agent, workers included),
  which outranks anything in a user-level prompt. Three fixes. (0) The `david-force` system-prompt section and the two rule blocks
  (`AGENTS.md`) now begin by saying they are addressed to the head agent and that an agent started by `david_run` / `david_ask` / the
  `david` CLI is exempt and must not answer "blocked". Verified live: with Codex first in every chain, the worker created the file
  where it had refused three times before. (1) `prompts/worker.md`, `ask.md` and
  `researcher.md` now say the rule is addressed to the caller, does not apply to the child, and that the child must never answer
  "blocked" because of it. (2) A run whose workers produced an **empty diff** is no longer `done`: it is `awaiting_human`, with a
  note `no files changed: the workers produced no diff. They said: ...` quoting the workers, so the head agent sees why. An empty
  diff is exactly what a refusing worker and a finished no-op leave, and the report used to be green for both.

### Added
- **Prompt-cache visibility.** The report's "Who ran" line now ends with `cache 66% of 3 calls` for every child, read from the
  `usage` of the child's own session (`inputTokens` is the part that was not a cache hit, `cacheReadTokens` the part that was;
  `lib/progress.js` `usage()`). When a route answers three or more calls with under 20% hits, a note says so once per run:
  `cache: deepseek (deepseek-host/...) answered 19 calls with 0% prompt-cache hits (505767 tokens at full price): that provider is
  not caching this session`. Measured on this machine, 25 h: the head agent's own DeepSeek account hits 99% after the first call and
  `cursor-workers` 94%, but the `deepseek-host` route (a third-party gateway, `modelapi.vn`) hit 74%, because three whole sessions
  (19, 12 and 8 calls) hit 0% on every call while its other sessions hit 97-99%: about 90% of that route's uncached tokens.
  The token estimates the ledger counts are unchanged.

### Added
- **`DAVID_FORCE_DIRECT_LIMIT`**: how many direct tool calls a DeepSeek head-agent turn may make before it is sent back to use
  `david_*` (default 6, like the Codex hook's `DAVID_FORCE_STOP_MIN`). A positive integer only; anything else falls back to 6; read
  at every check. (Written by the DeepSeek harness through `david_run` with the david-force rule ON, asked to "just edit it
  yourself": it routed through `david_run` anyway.)
- **`david status --json`**: the same three checks (Harness runtime, desktop patch, david plugin version) as one JSON object,
  `{"ok": ..., "checks": [{"name", "ok", "detail"}]}`, on a single line; the exit code is the same as without `--json`, and the
  text output is unchanged. (Written by the DeepSeek harness through `david_run` with the david-force rule ON: it used
  `david_ask` to read the code, `david_run` to write it, and made no direct edit.)

## [0.12.0] - 2026-10-07

### Changed
- **`david-force` has one switch per harness.** `/david-force on` now governs the DeepSeek harness only; Codex and Claude Code are
  governed only after `on codex` / `on claude` (or `on all`), and `off` with no target turns all of them off (`off codex` turns one
  off). 0.11.0 switched Codex on together with DeepSeek, which was not what was asked for. `state.json` carries
  `{"on", "harnesses": {"deepseek", "codex", "claude"}}`; a state file from 0.11.0 (`{"on": true}`) is read as "DeepSeek".
  `status` shows each harness.
- Each hook names its harness (`DAVID_FORCE_HARNESS=codex|claude` in its command line), so a Codex switch never governs Claude
  Code and the other way round; a hook installed before that is Codex's. `install` rewrites the Codex hooks to carry it.

### Added
- **`on claude`: Claude Code can be governed too, opt-in.** It adds the same four hooks to `~/.claude/settings.json` (`PreToolUse`
  only for `Bash|Edit|Write|MultiEdit|NotebookEdit`) and a rule block to `~/.claude/CLAUDE.md`, each file saved first; the owner's own
  hooks and settings are kept. `install` adds nothing to Claude's settings, and `uninstall` removes what `on claude` added.
- `lib/force.js` exports `enabled(harness)`; the plugin's guard, system-prompt rule and steering follow the `deepseek` switch.

## [0.11.0] - 2026-10-07

### Added
- **The `david-force` skill: david is mandatory, with `/david-force on | off | status`** (`skill/david-force/`). The head
  agent was free to ignore the rule in `AGENTS.md`; this makes it a hard guard, for DeepSeek Harness and for Codex, behind
  one switch (`~/.david-force/state.json`, read on every call, so toggling needs no restart). It installs OFF.
  - **DeepSeek Harness** (`lib/force.js`, loaded by the plugin): a `ctx.tools.guard()` refuses `edit`, `write` and
    file-changing `bash` for the head agent when they touch a git repository (the model reads the refusal and calls
    `david_run`); the plugin's own workers are sub-agents and are never refused; a system-prompt section carries the rule while
    ON; a turn of six or more direct tool calls that never called a `david_*` tool is sent back once.
  - **Codex** (`PreToolUse` guard, `UserPromptSubmit`, `PostToolUse` and `Stop` hooks in `~/.codex/hooks.json`, plus an
    `AGENTS.md` block): direct file changes in a repository are denied with the way to do it through david; every prompt
    restates the rule; a turn of five or more tool calls that never ran `david` is sent back once. Codex reaches the plugin
    through the new **`david` CLI** (`~/.david-force/bin/david run|ask|status`), which starts a headless Harness on the
    owner's profile, has its agent call `david_run` / `david_ask` once, and prints the tool's text taken from the event stream
    by call id. Exit code: 0 ok, 10 awaiting_human, 11 failed, 2 the call itself did not work.
  - **What it never blocks:** reads; anything outside a git repository (`~/.dsh`, `~/.codex`, `~/.claude`, `~/.agents`, `/tmp`,
    plus `~/.david-force/allow.txt`); a repository rooted at `$HOME`; the `david` CLI. Python and JS decide what counts as a write
    from one table (`skill/david-force/tests/commands.json`), so they cannot drift apart.
- **One zip for both halves.** `david-plugin-<version>.zip` now holds the plugin and the skill, and `install.sh` installs both
  (`--no-skill` to skip), `uninstall.sh` removes both (`--keep-skill` to keep it).

### Fixed
- **`dev/build.sh` packed the repository's `.git` folder into every zip.** The history holds every earlier zip, so each build was
  about twice the size of the last (0.7.7 was 71 MB for 200 KB of files). The staging copy drops `.git` and `__pycache__`, the
  build refuses to run when the plugin or the skill is missing from it, and a test bounds the size.

## [0.10.0] - 2026-10-07

### Added
- **`david_ask`: a read-only way to hand a question to the plugin** (`lib/pipeline.js` `runAsk`, `prompts/ask.md`,
  `index.js` `buildAskTool`). The head agent had no way to delegate an investigation: `david_run` grades a git diff and
  throws when the folder is not a repository, so "where did Anjum say that this morning?" was done by the head agent
  itself, 28 shell commands in its own context (every step re-sends all of it, which is where the tokens go). Now one call
  hands the question to a read-only investigator and returns the answer first, then the evidence (paths and lines).
  It runs on the researcher chain (the manager seat, then backup) with the "ask" prompt, no write/edit/bash tools, no git,
  no diff, no tests, and goes through `david_run`'s own `execute`, so the same ledger, step feed, run log and dashboard
  apply (it shows as the `ask` stage in the MANAGER column). Parameters: `question` (required), `cwd` (default: the home
  directory), `max_words` (50 to 1500, default 400). When every route fails it returns `awaiting_human` with each route's
  reason instead of an empty answer. Children never get it (`childTools.denyAll`).
- `dev/verify-against-harness.mjs` checks both tools' schemas against the Harness's `defineTool()`.

### Changed
- `david_run`'s description now says to use `david_ask` to find something out.

## [0.9.0] - 2026-10-07

### Changed (breaking)
- **Everything called "jev" is now "david", except Jev AI** (the hosted API, its model names, its key file and the
  local Laya engine behind it, and the "Jev · gate" node that shows its answer). So the tools are
  `david_run` / `david_probe` / `david_watch` (were `jev_run` / `jev_probe` / `jev_watch`); the data files are
  `~/.dsh/david-runs.jsonl`, `david-steps.jsonl`, `david-ledger.json`; the environment variables are
  `DAVID_SKIP_LAUNCHCTL`, `DAVID_RUN_LOG`, `DAVID_RUNS_FILE`, `DAVID_STEPS_FILE`, `DAVID_LEDGER_FILE`,
  `DAVID_9ROUTER_DB`, `DAVID_ACCEPTANCE_KEY`, `DAVID_API_TEST_KEY` (were `JEV_*`); backups made by the scripts are
  `.bak-david-*`. Unchanged because they belong to Jev AI: model `jev-latest`, `~/.dsh/jev/typesafe.key`,
  `~/.dsh/jev/laya-keepalive.sh`, the `com.jev.laya-keepalive` LaunchAgent, the `laya.*` config keys.
- **Upgrading:** run `./install.sh` and restart the Harness. Then edit anything of yours that names the old tools:
  `install.sh` rewrites `jev_run` / `jev_probe` / `jev_watch` inside the plugin's own block of `cordis.patch.yml`
  (e.g. a `childTools` filter; backup `cordis.patch.yml.bak-tools-<time>`), but `~/.dsh/AGENTS.md` and any other file
  that tells an agent to call `jev_run` are yours: until they say `david_run` the agent will call a tool that no
  longer exists. A session that was open before the restart still has the old tools until it is reopened.
- **History is kept:** the first start under 0.9.0 copies the old `jev-*` files to their `david-*` names when the new
  one does not exist yet (`lib/legacy.js`; `watch.mjs` and `who.mjs` do the same on first use). The originals are left
  in place and are no longer written.

## [0.8.0] - 2026-10-07

### Changed
- **The plugin is now called "david plugin"** (it was `jev-orchestrator`). Id and folder `david-plugin`
  (`plugin/david-plugin/`, `patch/david-plugin.patch.yml`), package name, the log prefix `[david-plugin]`, the
  patch markers and id, the zip (`david-plugin-<version>.zip`, folder `david-plugin/` inside), the report footer
  (`Plugin: david plugin <version>`) and the dashboard title.
- **Deliberately unchanged:** the tools `jev_run` / `jev_probe` / `jev_watch`, the data files (`~/.dsh/jev-*.jsonl`,
  `jev-ledger.json`), every config key, and the `AGENTS.md` rules that call the tools. Nothing the Harness agent
  does needs to change.
- **Upgrading:** run `./install.sh`, then restart the Harness. An install under the old name is renamed in place:
  the new copy replaces `plugins/jev-orchestrator`, and in `cordis.patch.yml` only the block's id, plugin path and
  its two markers are rewritten. The block itself (your routes, budgets, chains) is kept, never replaced by the
  template, and the old file is saved next to it as `cordis.patch.yml.bak-rename-<time>`. `./uninstall.sh` removes an
  install under either name.

### Added
- **Planner and researcher share one MANAGER column in the FLOW graph** (`lib/ui/index.html`). Both are jobs of the
  one manager seat (it rotates codex <-> deepseek-host), but the graph drew them as two separate stages that read as
  "skipped" and a seat box floating underneath. The seat is now a stage in the path: each planner / researcher that
  ran appears there with its route and turn, and a run that needed neither shows one idle "planner · researcher" node.
- **A bigger session log** with a `⤢ rộng` toggle (the log takes the whole width, remembered per browser). Rows are
  12 px, the pane is up to 70% of the window height (was 420 px), the right column is 46% of the width (was 460 px),
  and below 1100 px everything stacks instead of the stage cards sliding under the log.
- **The FLOW graph shows direction and what each running stage is doing right now** (`lib/ui/index.html`). Every
  edge ends in an arrowhead (blue and thicker while a stage runs, green once travelled, a hop through a skipped
  stage counts as travelled), and a running node carries a live line with the child's latest action
  (`gọi bash …`, `nghĩ …`, `kết edit ok …`) and a blinking cursor.

### Fixed
- **The first page to connect was sent the whole steps file again as "new" steps** (`lib/dashboard.js`). The tail
  offset stayed at 0 while nobody was watching, so the snapshot's log rows were repeated and every old line popped
  a bubble on the graph. The offset now follows the end of the file while no page is connected.
- **The Jev gate node picked up `jev` lines of other runs** (operator precedence in its filter).
- **The dashboard froze on the first snapshot: stage cards, the FLOW graph and the cost block only changed after a
  page reload.** The server sent one `snapshot` on connect and afterwards only single `step` lines, which extend
  the log and nothing else. It now pushes a fresh snapshot whenever steps arrive (and every ~5 s while someone is
  watching), and the page asks `/state` itself when no snapshot has come for a few seconds, so it also follows a
  server that has not been restarted onto this version.
- **The animated edges never travelled.** The page rebuilt the whole SVG once a second, which restarted every
  moving dot from zero before it got anywhere. The graph is redrawn only when an edge actually changes.
- The snapshot re-parsed the whole steps file on every call; parsed lines are now kept until the file's size or
  mtime moves (a line can carry 1200 characters of detail since 0.7.7).
- **A cancelled or crashed run showed RUNNING on the dashboard until the next run replaced it.** Only a successful
  run wrote a closing step line, so the head node pulsed and the tag read RUNNING long after the worker said
  "cancelled". A failed run now writes `run ended: <error>` (status `error`), and the dashboard also closes any run
  the run log says has ended, which fixes runs that were cancelled before this change.

## [0.7.7] - 2026-10-07

### Added
- **The feed says what a child is doing, not only which tool it called** (`lib/progress.js`, dashboard).
  Every line now carries a `kind`: `nghĩ` (the model's reasoning), `nói` (its reply), `gọi` (a tool call),
  `kết` (what that call returned: `bash exit 1: ...`, `read ok: path · N dòng`), `retry` (the upstream failed
  and the Harness is retrying, with the error code), `lỗi` (a turn that ended in error) and `duyệt` (a request
  to leave the sandbox, and the answer). A line is one bounded row (`progress.maxLineChars`, 180); the full
  text rides along as `detail` (`progress.detailChars`, 1200), written only when it says more than the row.
  `progress.results: false` drops the `kết` lines (a sandbox refusal is still shown).
- **Dashboard session log**: a coloured label per kind, click a row to open its detail (the full thought, the
  command as `$ ...`, the output), a `chi tiết` chip to open every row, and a chip per kind to filter. The log
  only follows the bottom when you are already there, so opening a row no longer jumps the view away.

### Fixed
- **A child's replies and thoughts never reached the feed.** `summarise()` read `data.content`, but the real
  session event keeps it at `data.message.content`, so only tool calls were ever shown. Both shapes are read now.
- **A child's own words could flip a stage card.** `stagesOf` inferred done/failed from "done in" / "failed in"
  in any line, so a command output or a thought containing the phrase would finish or fail the card. Lines
  written by the child (`child: true`) no longer move a stage's status.
- **A cancelled call left its card "running" forever.** The 0.7.6 line "cancelled after" was not recognised by
  `stagesOf`; the stage now shows failed.

## [0.7.6] - 2026-10-07

### Added
- **FLOW panel on the live dashboard** (`lib/ui/index.html`): the whole pipeline as an animated graph —
  head, the Jev gate, planner, researchers and workers in parallel, reviewer, final review, result — with
  a node per real stage, animated edges and a travelling dot while a stage runs, the rotating manager seat
  linked to every stage it took (`via manager`, with its turn), and a ring plus a short bubble for every
  step the feed receives. UI only; the page is read on every request.

### Fixed
- **A call cancelled mid-flight was recorded as `ok` with 0 output tokens** (`lib/pipeline.js`). The
  cancel path rethrew before `failure` was set, so two cancelled runs (431 s and 258 s, nothing returned)
  showed a worker "ok" in the run log. The trace now says `cancelled` with the reason, the step feed says
  "cancelled after", and `who.mjs` and the report mark it CANCELLED. Still no other route is tried after a cancel.
- **File dumps raised a false sandbox-refusal warning** (`lib/progress.js`). The refusal regex ran over the
  whole tool result, so reading any file that mentions the phrase (this module included) was flagged. Only
  the first 120 characters are tested and `<path>` dumps are skipped.
- **`watch.mjs` replayed the oldest 50 9Router rows as if live** (`watch.mjs`). It started at row id 0, so
  days-old calls appeared with time-only stamps. `--once` now shows the last 20, follow mode only what
  arrives after it starts, and rows older than today carry their date.

## [0.7.5] - 2026-10-07

### Added
- **A live feed of what each child is doing** (`lib/progress.js`). The Harness publishes only
  `subagent/start` and `subagent/end` for a child, so a step feed built from those alone goes silent
  for the whole call: on 2026-10-07 a worker card read `đang chạy · 224s…` with no line in between,
  and the owner asked why a run that says it is running returns no log. The child's session log was
  on disk the whole time — `<sessionsDir>/<project>/<sessionId>/session.v4.jsonl.zstd`, one zstd
  frame per appended event — and `subagent/start`'s `identity.id` IS that `sessionId`.

  `jev_run` now watches it: each poll decodes the frames appended since the last one and writes one
  step line per assistant message, tool call and sandbox refusal, so the dashboard streams a child
  while it works instead of only after it finishes. A child that says nothing for 30s still gets a
  `vẫn chạy Ns…` line, because the silence was the complaint. Watching costs nothing: file reads
  only, no model call, no HTTP.

  The decoder deliberately holds back an unfinished trailing frame — measured on this machine, a
  zstd frame cut to 12 bytes still decompresses (to `{"n`), so "it decompressed" is not "it is
  complete", and trusting it would silently discard the rest of that event.

### Notes
- New config block `progress: { enabled, pollMs, heartbeatMs, maxLineChars, sessionsDir }`; defaults
  are 1s polling, a 30s heartbeat, 180-char lines, and `~/.dsh/sessions`. Needs the runtime's
  built-in zstd (`node:zlib`).


## [0.7.4] - 2026-10-07

### Added
- **A live dashboard, and its link in every report** (`lib/dashboard.js`, `lib/ui/index.html`). A
  read-only HTTP server inside the plugin process, bound to 127.0.0.1, started once when the plugin
  loads. `jev_run` prints `Live: http://127.0.0.1:8787` as the second line of its report, and the
  owner follows the run in a browser: one card per stage showing the route and model serving it,
  `via manager` with the seat's turn number, a live second counter while it runs, the USD billed to
  that stage, and the step feed streaming below with per-route filter chips and a "this run only"
  toggle.

  It reads the same four files `jev_watch` reads - step feed, run log, ledger, 9Router's read-only
  SQLite - so watching costs no model call and no quota, which is the only reason it is safe to
  leave open. `GET /state` serves the same snapshot as JSON and `GET /events` is SSE (snapshot on
  connect, then one frame per new step line, heartbeats every 15s). A busy port moves to the next
  one, an unreadable or half-written file is an empty list, and a failure to listen logs a single
  line and lets the run continue: the dashboard can never break a run.
- `dev/test/dashboard.test.mjs` - stage derivation, the current-run match, the HTTP surface, and a
  clean stop.

### Measured
Live smoke test on the owner's machine: it found run `muydtyou` (awaiting_human with the planner on
codex `via manager turn 1`, $0.1079, and worker-1 failed on backup), derived the CFO line from the
real ledger (`codex 6/40 calls`, `deepseek 6373/20000000 tokens`), today's `$16.5371 / 638 calls`
from 9Router, and the last ten upstream calls. `GET /` served the page, `/state` the snapshot and
`/events` opened with `event: snapshot`.

## [0.7.3] - 2026-10-07

### Added
- **A route that is dropped now says why** (`lib/roles.js`, `lib/pipeline.js`). `resolveRole` returns
  `skipped: [{ key, why }]` for every chain entry it refused - missing from the config, failed earlier
  in this call, cooling down after a failure, or out of budget with the numbers
  (`needs 4200 tokens, has 0 left`). The pipeline writes one step-feed line per refusal, so
  `jev_watch`, `watch.mjs` and the dashboard show it for free.

### Measured
This is not hypothetical. On 2026-10-07 a worker stage went to Cursor (290s, no output) and then to
backup (52s, no output) while `deepseek`, the FIRST entry of the worker chain, was never offered at
all and nothing on disk said why; the same silent drop happened under 0.7.1. A full-fidelity
reproduction (real config, real ledger, real cost tracker, real prompt files) picks `deepseek`
correctly, so the difference lives in the running process's own state - which is exactly what was
invisible. It is not invisible any more.

## [0.7.2] - 2026-10-07

### Fixed
- **Cost was attributed by the wrong identifier, so an unmatched route was charged the whole
  machine** (`lib/cost.js` `reconcile`, new `usage` descriptor in `lib/config.js`). 9Router logs the
  *resolved* upstream call, not the combo we asked for: our route `codex` is `router9/codex-head`,
  but the row says `provider "codex"`, `model "gpt-6.1-sol"`; our route `deepseek` is
  `deepseek-host/deepseek-v4.1-flash`, and the row says `provider "openai-compatible-chat-<uuid>"`.
  Matching on our own identifiers matched **zero** rows, and the old fallback then summed *every* row
  written after the watermark — the head agent's own calls, other harnesses, every other app on the
  machine. Measured 2026-10-07: one worker call was billed `$3.5211` of other processes' traffic,
  `taskUsd` reached `$3.63` against a `$0.10` cap, the `deepseek` route was refused, and the run fell
  through to Cursor, where it hung 627s and produced nothing. A route now carries a `usage`
  descriptor (exact string, list, or trailing-`*` glob) naming what 9Router will actually write, and
  **a route that matches nothing is charged `$0`** and reports `unmatched` instead of swallowing the
  window. Under-charging hides spend; over-charging silently kills the run.
- **The task wallet counted list prices from free routes** (`lib/pipeline.js`). `chargeTaskUsd` ran
  for every route, so the fictional USD 9Router writes for a free relay could push a run over its cap
  and knock it off the only route that costs real money. Only `cost === "money"` routes feed the
  wallet now; the step feed and the trace still report the raw number, because the owner must see it.
- **Retry multiplication was invisible.** A combo that retries once per member writes N rows for one
  logical call (measured on a second Mac: one 52,794-token prompt, 7 rows of `$0.110868`, zero output
  tokens). The trace now carries `attempts`, the step feed says `(7 upstream attempts)`, and the
  learned per-call cost then makes the per-call cap refuse that route next time.

### Added
- **The `manager` office is a rotating seat** (`lib/roles.js`, `lib/config.js`). `manager` is no
  longer a route pointing at the dead `manager-temp` Cursor combo (HTTP 200, empty body): it is
  `{ rotate: ["codex", "deepseek"] }`, and `planner`/`researcher` now start there. Round-robin on
  purpose — Codex and DeepSeek-host take turns, so neither one's quota nor its wallet decides the job
  alone. A member that is skipped, cooling or out of budget hands the turn over without disturbing
  the alternation; when no member can take it, the chain falls through to `backup`. The counter is
  one `Map` per process, beside `health` and the limiter, so turns keep alternating across every
  `jev_run`. The returned route is always the **member** (its key, caps, probe flag and ledger), with
  `via: "manager"` and `turn: N` for the trace and the step feed.
- `dev/test/roles.test.mjs`, and a rewritten attribution suite in `dev/test/cost.test.mjs`.

### Measured
Against the live 9Router database (4238 rows) with the new matching: `codex` → 648 calls/$32.7154,
`cursor` → 2457/$245.9037, `deepseek` → 17/$0.0109, `backup` → 635/$0.0000 — each one exactly the
rows that upstream wrote, where the old code charged all 4238 to whichever route asked first. The
seat was exercised live as well: five consecutive `planner` resolutions give
`codex → deepseek → codex → deepseek → codex` (`turn` 1..5), and with Codex out of quota every turn
goes to DeepSeek. `probe: true` now exists on `cursor` alone.

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

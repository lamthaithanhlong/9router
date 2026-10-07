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

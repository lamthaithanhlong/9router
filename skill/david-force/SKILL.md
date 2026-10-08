---
name: david-force
description: Force DeepSeek Harness (and, only when switched on, Codex and Claude Code) to use the david plugin for everything - code changes through david_run, searches and investigations through david_ask - with a hard guard instead of a polite request. Commands `/david-force on` (DeepSeek harness), `/david-force on codex|claude|all`, `/david-force off [codex|claude|deepseek]`, `/david-force status`. Use when the owner says the harness or Codex is not using david, or wants david mandatory "by every means".
---

# /david-force — david plugin is mandatory (on | off), per harness

Version 1.1.0. A hard guard, not a request, with **one switch per harness**: `on` governs the DeepSeek harness; Codex and
Claude Code are governed only after they are switched on themselves.

## Commands

Run the script and show its output, nothing else:

| You type | Run | Effect |
|---|---|---|
| `/david-force on` | `python3 ~/.claude/skills/david-force/scripts/force.py on` | the **DeepSeek harness** only |
| `/david-force on codex` | `... force.py on codex` | also Codex (adds nothing to Claude) |
| `/david-force on claude` | `... force.py on claude` | also Claude Code (adds hooks to `~/.claude/settings.json`, a block to `~/.claude/CLAUDE.md`) |
| `/david-force on all` | `... force.py on all` | all three |
| `/david-force off` | `... force.py off` | all of them off |
| `/david-force off codex` | `... force.py off codex` | only that one off (`deepseek`, `codex`, `claude`) |
| `/david-force status` | `... force.py status` | per harness: ON or off, hooks, rule block |
| first time / repair | `... force.py install` | does not switch anything on |

A switch takes effect on the next tool call and never needs an app restart; only `install` (done by the plugin's `install.sh`)
does. Turning a harness off removes its rule block and leaves the hooks in place, doing nothing. State:
`~/.david-force/state.json`. A shell with `DAVID_FORCE_OFF=1` ignores the rule (for one command, for debugging).

Tuning: `DAVID_FORCE_DIRECT_LIMIT` (DeepSeek harness, default 6) and `DAVID_FORCE_STOP_MIN` (Codex and Claude hooks, default 5) set how
many direct tool calls a turn may make before it is sent back once to use david.

## What "mandatory" means, per harness

| Harness | Changes to files in a git repository | Searches and investigations |
|---|---|---|
| **DeepSeek Harness** (`on`) | the plugin's `tools.guard()` denies `edit`, `write` and file-changing `bash` for the head agent (the plugin's own workers are exempt); the model reads the denial and calls `david_run` | the system prompt gets the rule while ON; a turn of 6+ direct tool calls without `david_*` is sent back once with "use `david_ask`" |
| **Codex** (`on codex`) | the `PreToolUse` hook denies `apply_patch`, `>` redirects, `sed -i`, `git commit` ... in a repo and says to run `david run` | `UserPromptSubmit` restates the rule every prompt; `Stop` sends back, once per turn, a turn of 5+ tool calls that never ran `david` |
| **Claude Code** (`on claude`) | the same hooks, in `settings.json` (`Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`); Claude reads them from its next session | the same prompt reminder and `Stop` net |

Codex and Claude reach the plugin through the `david` CLI (`~/.david-force/bin/david run|ask|status`): it starts a headless
Harness on the owner's profile, has its agent call `david_run` / `david_ask` once and prints the tool's text. Exit code 0 ok,
10 awaiting_human, 11 failed, 2 the call itself did not work. The CLI works whether or not any switch is on.

## What it never blocks

Reads. Anything outside a git repository (`~/.dsh`, `~/.codex`, `~/.claude`, `~/.agents`, `/tmp` and any path listed in
`~/.david-force/allow.txt`). A repository rooted at `$HOME` (the memory backup) does not count as a repository. The `david`
CLI itself. If david is down, the agent says so and the owner decides: `/david-force off` is the only bypass.

## Limits, said plainly

- A model can still choose to ignore the request text; the denials are what hold. A write the guard cannot recognise
  (a program that writes files from inside a script it was handed) gets through, and the `Stop`/steer nudge is the net.
- Claude Code is governed only after `on claude`; until then nothing in its settings changes.
- Each `david` CLI call starts a Harness (a few seconds) and one small agent turn on top of the work itself.

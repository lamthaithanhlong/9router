---
name: david-force
description: Force Claude-side helpers, DeepSeek Harness and Codex to use the david plugin for everything - code changes through david_run, searches and investigations through david_ask - with a hard guard instead of a polite request. Commands `/david-force on`, `/david-force off`, `/david-force status`. Use when the owner says the harness or Codex is not using david, or wants david mandatory "by every means".
---

# /david-force — david plugin is mandatory (on | off)

Version 1.0.0. One switch for DeepSeek Harness and Codex; the rule is a hard guard, not a request.

## Commands

Run the script and show its output, nothing else:

| You type | Run |
|---|---|
| `/david-force on` | `python3 ~/.claude/skills/david-force/scripts/force.py on` |
| `/david-force off` | `python3 ~/.claude/skills/david-force/scripts/force.py off` |
| `/david-force status` | `python3 ~/.claude/skills/david-force/scripts/force.py status` |
| first time / repair | `python3 ~/.claude/skills/david-force/scripts/force.py install` (does not turn the rule on) |

`on` takes effect on the next tool call in DeepSeek Harness and Codex; it never needs a restart of the app, only the
`install` step (done by david plugin's `install.sh`) does. `off` removes the AGENTS.md blocks and leaves the hooks in place,
doing nothing. State: `~/.david-force/state.json`. A shell with `DAVID_FORCE_OFF=1` ignores the rule (for one command, for
debugging).

## What "mandatory" means, per harness

| Harness | Changes to files in a git repository | Searches and investigations |
|---|---|---|
| **DeepSeek Harness** | the plugin's `tools.guard()` denies `edit`, `write` and file-changing `bash` for the head agent (the plugin's own workers are exempt); the model reads the denial and calls `david_run` | the system prompt gets the rule while ON; a turn of 6+ direct tool calls without `david_*` is sent back once with "use `david_ask`" |
| **Codex** | the `PreToolUse` hook denies `apply_patch`, `>` redirects, `sed -i`, `git commit` ... in a repo and says to run `david run` | `UserPromptSubmit` restates the rule every prompt; `Stop` sends back, once per turn, a turn of 5+ tool calls that never ran `david` |

Codex reaches the plugin through the `david` CLI (`~/.david-force/bin/david run|ask|status`): it starts a headless Harness on
the owner's profile, has its agent call `david_run` / `david_ask` once and prints the tool's text. Exit code 0 ok,
10 awaiting_human, 11 failed, 2 the call itself did not work.

## What it never blocks

Reads. Anything outside a git repository (`~/.dsh`, `~/.codex`, `~/.claude`, `~/.agents`, `/tmp` and any path listed in
`~/.david-force/allow.txt`). A repository rooted at `$HOME` (the memory backup) does not count as a repository. The `david`
CLI itself. If david is down, the agent says so and the owner decides: `/david-force off` is the only bypass.

## Limits, said plainly

- A model can still choose to ignore the request text; the denials are what hold. A write the guard cannot recognise
  (a program that writes files from inside a script it was handed) gets through, and the `Stop`/steer nudge is the net.
- Claude Code itself is not governed by the hooks; this skill only installs for Codex and DeepSeek.
- Each `david` CLI call starts a Harness (a few seconds) and one small agent turn on top of the work itself.

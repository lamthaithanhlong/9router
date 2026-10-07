#!/usr/bin/env python3
"""david-force PreToolUse guard (Codex; Claude Code uses the same JSON protocol).

Reads the hook JSON on stdin ({"tool_name", "tool_input", "cwd", ...}). While the rule is ON and the call would change
files in a git repository (an edit tool, or a shell command that writes), it prints a PreToolUse deny with the way to
do it through david. Every other call, and every call while the rule is OFF, prints nothing. Fail open: a broken guard
must never be the reason a session is stuck.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def decide(data: dict):
    if not common.is_on():
        return None
    return common.reason_to_deny(data.get('tool_name'), data.get('tool_input') or {}, data.get('cwd') or '', 'codex')


def main() -> None:
    try:
        data = json.load(sys.stdin)
        if os.environ.get('DAVID_FORCE_DEBUG'):  # lets the owner see the real tool names a harness sends
            with open(common.force_home() / 'debug.jsonl', 'a') as fh:
                fh.write(json.dumps({'event': 'PreToolUse', 'tool_name': data.get('tool_name'),
                                     'tool_input': data.get('tool_input'), 'cwd': data.get('cwd')}, ensure_ascii=False)[:2000] + '\n')
        reason = decide(data)
        if reason:
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                                     'permissionDecisionReason': reason}}, ensure_ascii=False))
    except Exception:
        pass


if __name__ == '__main__':
    main()

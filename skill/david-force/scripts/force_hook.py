#!/usr/bin/env python3
"""david-force prompt / progress / stop hooks for Codex (one script, by hook_event_name).

  UserPromptSubmit  rule ON: reset this turn's counters and put the rule in front of the model again
  PostToolUse       rule ON: count the turn's tool calls, and the ones that called david
  Stop              rule ON, a turn of real work (STOP_MIN tool calls) that never called david: block once and send the
                    model back to do it through david. Once per turn, and never when the stop is already a continuation
                    (stop_hook_active), so it cannot loop.

Everything is fail open and silent while the rule is OFF.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

STOP_MIN = int(os.environ.get('DAVID_FORCE_STOP_MIN') or 5)

REMINDER = ('david-force is ON (owner rule, enforced by hooks): change files in a git repository only through '
            '`~/.david-force/bin/david run --cwd <repo> "<task>"`, and hand any search or investigation that needs more than a '
            'quick lookup to `~/.david-force/bin/david ask "<question>"`. Direct edits in a repository are denied.')


def _sessions():
    d = common.force_home() / 'sessions'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _file(sid: str):
    return _sessions() / (re.sub(r'[^A-Za-z0-9_.-]', '_', sid or 'unknown')[:80] + '.json')


def _load(sid: str) -> dict:
    try:
        return json.loads(_file(sid).read_text())
    except Exception:
        return {'tools': 0, 'david': 0, 'blocked': False}


def _save(sid: str, c: dict) -> None:
    _file(sid).write_text(json.dumps(c))
    cutoff = time.time() - 2 * 86400  # sessions are throw-away: keep the folder small
    for f in _sessions().glob('*.json'):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except Exception:
            pass


def handle(data: dict):
    if not common.is_on():
        return None
    event, sid = data.get('hook_event_name'), str(data.get('session_id') or data.get('sessionId') or '')
    if event == 'UserPromptSubmit':
        _save(sid, {'tools': 0, 'david': 0, 'blocked': False})
        return {'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': REMINDER}}
    if event == 'PostToolUse':
        c = _load(sid)
        c['tools'] += 1
        args = data.get('tool_input') or {}
        cmd = args.get('command', args.get('cmd', '')) if isinstance(args, dict) else ''
        if isinstance(cmd, list):
            cmd = ' '.join(map(str, cmd))
        if isinstance(cmd, str) and common.is_david_call(cmd):
            c['david'] += 1
        _save(sid, c)
        return None
    if event == 'Stop':
        if data.get('stop_hook_active'):
            return None
        c = _load(sid)
        if c['tools'] >= STOP_MIN and c['david'] == 0 and not c['blocked']:
            c['blocked'] = True
            _save(sid, c)
            return {'decision': 'block', 'reason': (
                f"david-force is ON and this turn made {c['tools']} tool calls without calling david. Do the rest through "
                'david: `~/.david-force/bin/david ask "<question>"` for anything you still need to find out, '
                '`~/.david-force/bin/david run --cwd <repo> "<task>"` for any change. If david cannot do it, say exactly why '
                'in your answer instead of doing it by hand.')}
    return None


def main() -> None:
    try:
        out = handle(json.load(sys.stdin))
        if out:
            print(json.dumps(out, ensure_ascii=False))
    except Exception:
        pass


if __name__ == '__main__':
    main()

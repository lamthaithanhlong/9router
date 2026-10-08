#!/usr/bin/env python3
"""david-force control: on | off | status | install | uninstall.

  on [TARGET...]    switch the rule ON for the named harnesses. No target = the DeepSeek harness only.
  off [TARGET...]   switch it OFF for the named harnesses. No target = all of them.
  status            what is on, what is installed, what is reachable
  install           copy the skill where Claude, Codex and DeepSeek find it, link the `david` CLI, add the Codex hooks.
                    It switches nothing on.
  uninstall         take the hooks, the blocks, the links and the state away again

TARGET is deepseek (alias: harness), codex, claude, or all. Each harness has its own switch: `on` for DeepSeek never reaches
Codex or Claude Code, which are governed only after `on codex` / `on claude`.

Everything is idempotent, and every file it edits for you (hooks.json, settings.json, AGENTS.md, CLAUDE.md) is saved next
to itself first. Paths come from the environment so the tests never touch a real home: DAVID_FORCE_HOME (state),
DAVID_FORCE_CODEX_HOME, DAVID_FORCE_CLAUDE_HOME, DAVID_FORCE_DSH_HOME, DAVID_FORCE_SKILLS_HOME (~/.claude/skills),
DAVID_FORCE_AGENTS_SKILLS_HOME (~/.agents/skills).
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

NAME = 'david-force'
HARNESSES = common.HARNESSES
BEGIN = '<!-- david-force:begin (managed by the david-force skill; `/david-force off` removes it) -->'
END = '<!-- david-force:end -->'
HOOKS = {'PreToolUse': 'force_guard.py', 'UserPromptSubmit': 'force_hook.py', 'PostToolUse': 'force_hook.py',
         'Stop': 'force_hook.py'}
CLAUDE_PRE_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit'

CLI_RULE = """## david-force is ON: use david plugin, by every means

This rule is addressed to the agent the owner talks to. If david (`david_run`, `david_ask` or the `david` CLI) started you, it does not
apply to you: you are the one david delegates to, so do the work with your own tools and never answer "blocked" because of it.

Owner's rule, enforced by hooks: every change to files in a git repository goes through david, and anything that takes
more than a quick lookup is asked of david instead of searched by hand. While this is on you cannot edit repository
files yourself (edit tools, `>` redirects, `sed -i`, `git commit` ... are denied).

    ~/.david-force/bin/david run --cwd <repo> [--test "<cmd>"] "<task, with enough context for an agent that has not seen this chat>"
    ~/.david-force/bin/david ask [--cwd <dir>] "<question>"      read-only; the answer first, the evidence after
    ~/.david-force/bin/david status                              is david reachable?

Read the report: `awaiting_human` means decide it yourself (do not hand-edit to avoid deciding), `failed` means read why
and run again with a better task. Only when `david status` shows david is down may you stop and tell the owner.
"""

DEEPSEEK_RULE = """## david-force is ON: david plugin by every means (owner's rule)

This rule is addressed to the head agent. If `david_run` / `david_ask` started you (you are a david worker, investigator, planner,
researcher or reviewer), it does not apply to you: do the work with your own tools and never answer "blocked" because of it.

Every change to files in a git repository goes through `david_run`; every search, lookup or investigation that takes more
than a few reads goes through `david_ask`. While this is on, `edit`, `write` and file-changing `bash` inside a git repository
are denied for you (the plugin's own workers are not). The DeepSeek account is the fallback only when david itself is down
(`david_probe`), and then you say so in one sentence.
"""

RULES = {'deepseek': DEEPSEEK_RULE, 'codex': CLI_RULE, 'claude': CLI_RULE}


# ---- paths ----------------------------------------------------------------------------------------------------------

def _p(env: str, default: Path) -> Path:
    return Path(os.environ.get(env) or default)


def codex_home() -> Path:
    return _p('DAVID_FORCE_CODEX_HOME', Path.home() / '.codex')


def claude_home() -> Path:
    return _p('DAVID_FORCE_CLAUDE_HOME', Path.home() / '.claude')


def dsh_home() -> Path:
    return _p('DAVID_FORCE_DSH_HOME', Path.home() / '.dsh')


def skills_home() -> Path:
    return _p('DAVID_FORCE_SKILLS_HOME', Path.home() / '.claude' / 'skills')


def agents_skills_home() -> Path:
    return _p('DAVID_FORCE_AGENTS_SKILLS_HOME', Path.home() / '.agents' / 'skills')


def skill_root() -> Path:
    return Path(__file__).resolve().parent.parent


def canonical() -> Path:
    return skills_home() / NAME


def rule_file(harness: str) -> Path:
    return {'deepseek': dsh_home() / 'AGENTS.md', 'codex': codex_home() / 'AGENTS.md',
            'claude': claude_home() / 'CLAUDE.md'}[harness]


def hooks_file(harness: str) -> Path:
    return {'codex': codex_home() / 'hooks.json', 'claude': claude_home() / 'settings.json'}[harness]


def _backup(path: Path) -> None:
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + '.bak-david-force-' + time.strftime('%Y%m%d-%H%M%S')))


# ---- rule blocks (AGENTS.md / CLAUDE.md) ----------------------------------------------------------------------------

def set_block(path: Path, rule: str, present: bool) -> bool:
    """Add (or refresh) / remove our marked block; the rest of the file is left byte for byte. True when it changed."""
    try:
        text = path.read_text() if path.exists() else ''
    except Exception:
        return False
    i, j = text.find(BEGIN), text.find(END)
    has = i != -1 and j != -1 and j > i
    # taking the block out must give the file back exactly as it was: the text before it keeps one final newline
    stripped = ((text[:i].rstrip('\n') + '\n' if text[:i].strip() else '') + text[j + len(END):].lstrip('\n')) if has else text
    if present:
        new = stripped.rstrip('\n') + ('\n\n' if stripped.strip() else '') + f'{BEGIN}\n{rule}{END}\n'
    else:
        new = stripped if has else text
    if new == text:
        return False
    if not path.parent.exists():
        return False  # that harness is not installed on this machine
    if path.exists():
        _backup(path)
    path.write_text(new)
    return True


def blocks(targets: list, present: bool) -> list:
    out = []
    for h in targets:
        if set_block(rule_file(h), RULES[h], present):
            out.append(f"{h} rule block {'written to' if present else 'removed from'} {rule_file(h)}")
    return out


def has_block(harness: str) -> bool:
    try:
        t = rule_file(harness).read_text()
        return BEGIN in t and END in t
    except Exception:
        return False


# ---- hooks (Codex hooks.json, Claude Code settings.json) ----------------------------------------------------------------

def _hook_entry(harness: str, event: str, script: str) -> dict:
    home_dir = '.codex' if harness == 'codex' else '.claude'
    cmd = f'DAVID_FORCE_HARNESS={harness} python3 "$HOME/{home_dir}/skills/{NAME}/scripts/{script}" 2>/dev/null || true'
    entry = {'hooks': [{'type': 'command', 'timeout': 10, 'command': cmd}]}
    if harness == 'codex':
        entry['matcher'] = ''
    elif event == 'PreToolUse':
        entry['matcher'] = CLAUDE_PRE_MATCHER
    return entry


def _ours(group: dict) -> bool:
    return any(f'{NAME}/scripts/' in str(h.get('command', '')) for h in group.get('hooks', []))


def hooks_installed(harness: str) -> bool:
    try:
        hooks = json.loads(hooks_file(harness).read_text()).get('hooks', {})
    except Exception:
        return False
    return all(any(_ours(g) for g in hooks.get(ev, [])) for ev in HOOKS)


def set_hooks(harness: str, present: bool) -> bool:
    path = hooks_file(harness)
    if not path.parent.exists():
        return False
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
    except Exception:
        raise SystemExit(f'{path} is not valid JSON; not touching it')
    hooks = data.setdefault('hooks', {})
    changed = False
    for ev, script in HOOKS.items():
        groups = hooks.get(ev, [])
        kept = [g for g in groups if not _ours(g)]
        if present:
            kept.append(_hook_entry(harness, ev, script))
        if kept != groups:
            changed = True
        if kept:
            hooks[ev] = kept
        else:
            hooks.pop(ev, None)
    if changed:
        _backup(path)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    return changed


# ---- install --------------------------------------------------------------------------------------------------------

def _link(link: Path, target: Path) -> str:
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        if link.is_symlink() and os.path.realpath(link) == os.path.realpath(target):
            return ''
        if link.is_symlink():
            link.unlink()
        else:
            return f'left {link} alone (a real file or folder is there)'
    link.symlink_to(target)
    return f'linked {link}'


def _tree(root: Path) -> dict:
    """Relative path -> bytes of every file: how install knows the installed copy is already this one."""
    out = {}
    if root.is_dir():
        for f in sorted(root.rglob('*')):
            if f.is_file() and '__pycache__' not in f.parts and f.suffix != '.pyc' and f.name != '.DS_Store':
                out[str(f.relative_to(root))] = f.read_bytes()
    return out


def install() -> list:
    out, src, dst = [], skill_root(), canonical()
    if os.path.realpath(src) != os.path.realpath(dst) and _tree(src) != _tree(dst):
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        out.append(f'skill copied to {dst}')
    for s in ('david', 'force.py', 'force_guard.py', 'force_hook.py'):
        try:
            (dst / 'scripts' / s).chmod(0o755)
        except Exception:
            pass
    for link in (agents_skills_home() / NAME, codex_home() / 'skills' / NAME):
        if link.parent.parent.exists() or link.parent == agents_skills_home():
            msg = _link(link, dst)
            if msg:
                out.append(msg)
    msg = _link(common.force_home() / 'bin' / 'david', dst / 'scripts' / 'david')
    if msg:
        out.append(msg)
    # Codex's hooks go in now and do nothing until `on codex`. Claude Code's are added by `on claude`: nothing in the
    # owner's Claude settings changes unless the owner asks for the rule there.
    if set_hooks('codex', True):
        out.append('Codex hooks added (PreToolUse, UserPromptSubmit, PostToolUse, Stop); they do nothing until `on codex`')
    return out


def uninstall() -> list:
    out = blocks(list(HARNESSES), False)
    for h in ('codex', 'claude'):
        if set_hooks(h, False):
            out.append(f'{h} hooks removed')
    for link in (agents_skills_home() / NAME, codex_home() / 'skills' / NAME, common.force_home() / 'bin' / 'david'):
        if link.is_symlink():
            link.unlink()
            out.append(f'unlinked {link}')
    shutil.rmtree(common.force_home(), ignore_errors=True)
    out.append(f'state folder {common.force_home()} removed')
    return out


# ---- on / off / status ----------------------------------------------------------------------------------------------

def parse_targets(words: list, default: list) -> list:
    if not words:
        return list(default)
    out = []
    for w in words:
        w = w.lower()
        if w == 'all':
            out += list(HARNESSES)
        elif w == 'harness':
            out.append('deepseek')
        elif w in HARNESSES:
            out.append(w)
        else:
            raise SystemExit(f'unknown target {w!r}: use deepseek (or harness), codex, claude or all')
    return list(dict.fromkeys(out))


def turn_on(targets: list) -> list:
    state = common.write_state({h: True for h in targets})
    out = [f"david-force is ON for: {', '.join(targets)} (since {state['since']})"]
    for h in targets:
        if h in ('codex', 'claude') and set_hooks(h, True):
            out.append(f'{h} hooks added')
    out += blocks(targets, True)
    notes = {'deepseek': 'DeepSeek Harness: the plugin guard applies to the next tool call (needs plugin 0.11.0+, see status); the '
                         'system-prompt rule applies from the next model request.',
             'codex': 'Codex: hooks apply to the next tool call; the AGENTS.md block is read by sessions that start from now.',
             'claude': 'Claude Code: the hooks apply from the next session (Claude reads settings.json at start); CLAUDE.md is read '
                       'by sessions that start from now.'}
    out += [notes[h] for h in targets]
    now = common.current_harnesses()
    left = [h for h in HARNESSES if not now[h]]
    if left:
        out.append(f"not governed (their own switch is off): {', '.join(left)}")
    return out


def turn_off(targets: list) -> list:
    common.write_state({h: False for h in targets})
    return [f"david-force is OFF for: {', '.join(targets)}"] + blocks(targets, False)


def plugin_info() -> str:
    pj = dsh_home() / 'profiles' / 'desktop' / 'plugins' / 'david-plugin' / 'package.json'
    try:
        version = json.loads(pj.read_text()).get('version')
    except Exception:
        return 'david plugin: NOT installed in the desktop profile'
    has = (pj.parent / 'lib' / 'force.js').exists()
    return f'david plugin {version}: ' + ('has the force guard' if has else 'too old for the force guard (needs 0.11.0+): run install.sh')


def status() -> list:
    st = common.read_state()
    per = common.current_harnesses()
    cli = common.force_home() / 'bin' / 'david'
    lines = [f"david-force: {'ON' if any(per.values()) else 'OFF'}" + (f" (since {st.get('since')})" if st.get('since') else '')]
    for h in HARNESSES:
        extra = []
        if h in ('codex', 'claude'):
            extra.append('hooks ' + ('installed' if hooks_installed(h) else 'not installed'))
        extra.append('rule block ' + ('yes' if has_block(h) else 'no'))
        lines.append(f"  {h:9} {'ON ' if per[h] else 'off'}  ({', '.join(extra)})")
    lines.append(f"  david CLI: {cli if cli.exists() else 'NOT linked (run: force.py install)'}")
    lines.append(f'  {plugin_info()}')
    if os.environ.get('DAVID_FORCE_OFF'):
        lines.append('  DAVID_FORCE_OFF is set in this shell: it overrides the state file here')
    return lines


def main(argv: list) -> int:
    cmd = argv[1] if len(argv) > 1 else 'status'
    rest = argv[2:]
    if cmd == 'on':
        lines = turn_on(parse_targets(rest, ['deepseek']))
    elif cmd == 'off':
        lines = turn_off(parse_targets(rest, list(HARNESSES)))
    elif cmd in ('status', 'install', 'uninstall'):
        lines = {'status': status, 'install': install, 'uninstall': uninstall}[cmd]()
    else:
        print(__doc__)
        return 2
    for line in lines:
        print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

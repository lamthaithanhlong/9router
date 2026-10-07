#!/usr/bin/env python3
"""david-force control: on | off | status | install | uninstall.

  on         the rule is ON: state file, the two AGENTS.md blocks, and (idempotently) the Codex hooks
  off        the rule is OFF: state file and both blocks removed; the hooks stay installed and do nothing
  status     what is on, what is installed, what is reachable
  install    copy the skill where Claude, Codex and DeepSeek find it, link the `david` CLI, add the Codex hooks.
             It does NOT turn the rule on.
  uninstall  take the hooks, the blocks, the links and the state away again

Everything is idempotent, and every file it edits for you (hooks.json, AGENTS.md) is saved next to itself first.
Paths come from the environment so the tests never touch a real home:
  DAVID_FORCE_HOME (state), DAVID_FORCE_CODEX_HOME (~/.codex), DAVID_FORCE_DSH_HOME (~/.dsh),
  DAVID_FORCE_SKILLS_HOME (~/.claude/skills), DAVID_FORCE_AGENTS_SKILLS_HOME (~/.agents/skills).
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
BEGIN = '<!-- david-force:begin (managed by the david-force skill; `/david-force off` removes it) -->'
END = '<!-- david-force:end -->'
HOOKS = {'PreToolUse': 'force_guard.py', 'UserPromptSubmit': 'force_hook.py', 'PostToolUse': 'force_hook.py',
         'Stop': 'force_hook.py'}

CODEX_RULE = """## david-force is ON: use david plugin, by every means

Owner's rule, enforced by hooks: every change to files in a git repository goes through david, and anything that takes
more than a quick lookup is asked of david instead of searched by hand. While this is on you cannot edit repository
files yourself (apply_patch, `>` redirects, `sed -i`, `git commit` ... are denied).

    ~/.david-force/bin/david run --cwd <repo> [--test "<cmd>"] "<task, with enough context for an agent that has not seen this chat>"
    ~/.david-force/bin/david ask [--cwd <dir>] "<question>"      read-only; the answer first, the evidence after
    ~/.david-force/bin/david status                              is david reachable?

Read the report: `awaiting_human` means decide it yourself (do not hand-edit to avoid deciding), `failed` means read why
and run again with a better task. Only when `david status` shows david is down may you stop and tell the owner.
"""

DEEPSEEK_RULE = """## david-force is ON: david plugin by every means (owner's rule)

Every change to files in a git repository goes through `david_run`; every search, lookup or investigation that takes more
than a few reads goes through `david_ask`. While this is on, `edit`, `write` and file-changing `bash` inside a git repository
are denied for you (the plugin's own workers are not). The DeepSeek account is the fallback only when david itself is down
(`david_probe`), and then you say so in one sentence.
"""


# ---- paths ----------------------------------------------------------------------------------------------------------

def _p(env: str, default: Path) -> Path:
    return Path(os.environ.get(env) or default)


def codex_home() -> Path:
    return _p('DAVID_FORCE_CODEX_HOME', Path.home() / '.codex')


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


def _backup(path: Path) -> None:
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + '.bak-david-force-' + time.strftime('%Y%m%d-%H%M%S')))


# ---- AGENTS.md blocks -----------------------------------------------------------------------------------------------

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


def blocks(present: bool) -> list:
    out = []
    for label, path, rule in (('codex', codex_home() / 'AGENTS.md', CODEX_RULE),
                              ('deepseek', dsh_home() / 'AGENTS.md', DEEPSEEK_RULE)):
        if set_block(path, rule, present):
            out.append(f"{label} AGENTS.md block {'written' if present else 'removed'}")
    return out


def has_block(path: Path) -> bool:
    try:
        t = path.read_text()
        return BEGIN in t and END in t
    except Exception:
        return False


# ---- Codex hooks ----------------------------------------------------------------------------------------------------

def _hook_entry(script: str) -> dict:
    return {'hooks': [{'type': 'command', 'timeout': 10,
                       'command': f'python3 "$HOME/.codex/skills/{NAME}/scripts/{script}" 2>/dev/null || true'}],
            'matcher': ''}


def _ours(group: dict) -> bool:
    return any(f'{NAME}/scripts/' in str(h.get('command', '')) for h in group.get('hooks', []))


def hooks_installed() -> bool:
    try:
        hooks = json.loads((codex_home() / 'hooks.json').read_text()).get('hooks', {})
    except Exception:
        return False
    return all(any(_ours(g) for g in hooks.get(ev, [])) for ev in HOOKS)


def set_hooks(present: bool) -> bool:
    path = codex_home() / 'hooks.json'
    if not codex_home().exists():
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
            kept.append(_hook_entry(script))
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
    if set_hooks(True):
        out.append('Codex hooks added (PreToolUse, UserPromptSubmit, PostToolUse, Stop); they do nothing while the rule is OFF')
    return out


def uninstall() -> list:
    out = blocks(False)
    if set_hooks(False):
        out.append('Codex hooks removed')
    for link in (agents_skills_home() / NAME, codex_home() / 'skills' / NAME, common.force_home() / 'bin' / 'david'):
        if link.is_symlink():
            link.unlink()
            out.append(f'unlinked {link}')
    shutil.rmtree(common.force_home(), ignore_errors=True)
    out.append(f'state folder {common.force_home()} removed')
    return out


# ---- on / off / status ----------------------------------------------------------------------------------------------

def turn_on() -> list:
    state = common.write_state(True)
    out = [f"david-force is ON (since {state['since']})"]
    if set_hooks(True):
        out.append('Codex hooks added')
    out += blocks(True)
    out.append('Codex: hooks apply to the next tool call; the AGENTS.md block is read by sessions that start from now.')
    out.append('DeepSeek Harness: the plugin guard applies to the next tool call (needs plugin 0.11.0+, see status); '
               'the system-prompt rule applies from the next model request.')
    return out


def turn_off() -> list:
    common.write_state(False)
    return ['david-force is OFF'] + blocks(False)


def plugin_info() -> str:
    dsh = dsh_home()
    pj = dsh / 'profiles' / 'desktop' / 'plugins' / 'david-plugin' / 'package.json'
    try:
        version = json.loads(pj.read_text()).get('version')
    except Exception:
        return 'david plugin: NOT installed in the desktop profile'
    has = (pj.parent / 'lib' / 'force.js').exists()
    return f'david plugin {version}: ' + ('has the force guard' if has else 'too old for the force guard (needs 0.11.0+): run install.sh')


def status() -> list:
    st = common.read_state()
    on = common.is_on()
    cli = common.force_home() / 'bin' / 'david'
    lines = [f"david-force: {'ON' if on else 'OFF'}" + (f" (since {st.get('since')})" if st.get('since') else ''),
             f"  Codex hooks:        {'installed' if hooks_installed() else 'NOT installed (run: force.py install)'}",
             f"  Codex AGENTS block: {'yes' if has_block(codex_home() / 'AGENTS.md') else 'no'}",
             f"  DeepSeek AGENTS block: {'yes' if has_block(dsh_home() / 'AGENTS.md') else 'no'}",
             f"  david CLI:          {cli if cli.exists() else 'NOT linked (run: force.py install)'}",
             f'  {plugin_info()}']
    if os.environ.get('DAVID_FORCE_OFF'):
        lines.append('  DAVID_FORCE_OFF is set in this shell: it overrides the state file here')
    return lines


def main(argv: list) -> int:
    cmd = argv[1] if len(argv) > 1 else 'status'
    fn = {'on': turn_on, 'off': turn_off, 'status': status, 'install': install, 'uninstall': uninstall}.get(cmd)
    if fn is None:
        print(__doc__)
        return 2
    for line in fn():
        print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

"""david-force: shared state and the one decision the guards make.

The question every guard asks: is this tool call a harness changing files in a git repository by itself, when david
plugin should have done it? Answers are conservative on purpose: a read is never denied, and nothing outside a git
repository (the owner's own config in ~/.dsh, ~/.codex, ~/.claude, a scratch dir) is ever denied. A guard that is
wrong about a read costs the owner a stuck session; one that is wrong about a write costs a bypassed rule, so the
lists below lean towards "this looks like a write" only for commands that really write.

dev/test and the plugin's lib/force.js share tests/commands.json, so the Python hooks (Codex) and the JS guard
(DeepSeek Harness) agree on what counts as a write.
"""
import json
import os
import re
import tempfile
from pathlib import Path


def force_home() -> Path:
    return Path(os.environ.get('DAVID_FORCE_HOME') or (Path.home() / '.david-force'))


def state_path() -> Path:
    return force_home() / 'state.json'


def read_state() -> dict:
    try:
        data = json.loads(state_path().read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


HARNESSES = ('deepseek', 'codex', 'claude')


def enabled(harness: str) -> bool:
    """Is the rule ON for this harness? Each harness has its own switch: turning it on for DeepSeek never reaches Codex
    or Claude Code. Fail open: a missing or broken state file means OFF, never a stuck harness.

    A state file from before the switches were per harness ({"on": true}) meant "the DeepSeek harness".
    """
    if os.environ.get('DAVID_FORCE_OFF'):
        return False
    st = read_state()
    per = st.get('harnesses')
    if isinstance(per, dict):
        return per.get(harness) is True
    return harness == 'deepseek' and st.get('on') is True


def is_on(harness: 'str | None' = None) -> bool:
    """The hooks say which harness runs them (DAVID_FORCE_HARNESS=codex|claude in their command line); a hook installed
    before that existed is Codex's, and Codex is only governed when the owner switched Codex on."""
    return enabled(harness or os.environ.get('DAVID_FORCE_HARNESS') or 'codex')


def current_harnesses() -> dict:
    st = read_state()
    per = st.get('harnesses')
    if isinstance(per, dict):
        return {h: per.get(h) is True for h in HARNESSES}
    return {h: (h == 'deepseek' and st.get('on') is True) for h in HARNESSES}


def write_state(updates, by: str = 'cli') -> dict:
    """Merge {harness: bool} into the state (True/False alone means the DeepSeek harness: the old single switch)."""
    from datetime import datetime, timezone
    if isinstance(updates, bool):
        updates = {'deepseek': updates}
    per = current_harnesses()
    per.update({h: bool(v) for h, v in updates.items() if h in HARNESSES})
    state = {'on': any(per.values()), 'harnesses': per,
             'since': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'by': by}
    home = force_home()
    home.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(home), prefix='.state-')
    with os.fdopen(fd, 'w') as fh:
        json.dump(state, fh)
    os.replace(tmp, state_path())  # atomic: a guard never reads half a file
    return state


# ---- where direct edits are fine -----------------------------------------------------------------------------------

def allowed_prefixes() -> list:
    """The owner's own tooling and scratch space: never a repo david should be changing."""
    home = Path.home()
    out = [home / d for d in ('.david-force', '.dsh', '.codex', '.claude', '.agents', '.backend-review')]
    tmp = os.environ.get('DAVID_FORCE_TMP_ALLOW', '/tmp:/private/tmp:/var/folders:/private/var/folders')
    out += [Path(x) for x in tmp.split(':') if x]
    extra = force_home() / 'allow.txt'
    try:
        for line in extra.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                out.append(Path(os.path.expanduser(line)))
    except Exception:
        pass
    return out


def _under(path: Path, prefix: Path) -> bool:
    try:
        path.relative_to(os.path.realpath(prefix))
        return True
    except ValueError:
        pass
    try:
        path.relative_to(prefix)
        return True
    except ValueError:
        return False


def repo_of(path) -> 'Path | None':
    """The git work tree this path belongs to, or None when david has no business with it.

    $HOME is itself a repository on the owner's machine (the memory backup): treating that as "a repo" would deny every
    edit to a dotfile, so a repository rooted at $HOME does not count.
    """
    try:
        p = Path(os.path.realpath(os.path.expanduser(str(path))))
    except Exception:
        return None
    for pre in allowed_prefixes():
        if _under(p, pre):
            return None
    home = Path(os.path.realpath(Path.home()))
    cur = p
    while True:
        if (cur / '.git').exists():
            return None if cur == home else cur
        if cur.parent == cur:
            return None
        cur = cur.parent


# ---- shell commands: does this one write? --------------------------------------------------------------------------

_HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n.*?\n[ \t]*\2[ \t]*(?=\n|$)", re.S)
_QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
_REDIRECT = re.compile(r'(?:^|[^0-9&<>=\-])>>?(?!&)[ \t]*(?!/dev/null(?![\w/]))[^\s|;&<>)]')
_AMP_REDIRECT = re.compile(r'&>>?[ \t]*(?!/dev/null(?![\w/]))[^\s|;&<>)]')
_CMD_POS = r'(?:^|[;&|(\n`]\s*|\bsudo\s+|\bxargs\s+(?:-\S+\s+)*)'
_VERBS = re.compile(_CMD_POS + r'(?:mv|cp|rm|rmdir|touch|mkdir|ln|truncate|chmod|chown|patch|tee|install|rsync|unlink)\b')
_INPLACE = re.compile(r'\b(?:sed|perl)\b[^|;&\n]*\s(?:-[A-Za-z]*i\b|--in-place\b)')
_DD = re.compile(r'\bdd\b[^|;&\n]*\bof=')
_GIT = re.compile(r'\bgit\s+(?:-C\s+\S+\s+)?(?:commit|add|apply|am|checkout|switch|restore|reset|revert|merge|rebase|'
                  r'cherry-pick|stash|pull|clean|rm|mv|push|tag|worktree|init|clone)\b')
_CODE_WRITES = re.compile(
    r"open\s*\([^)]*,\s*['\"][^'\"]*[wax+][^'\"]*['\"]|\.write_text\(|\.write_bytes\(|writeFileSync|appendFileSync|"
    r"\bwriteFile\(|\bappendFile\(|fs\.write|createWriteStream|os\.(?:remove|unlink|rename|replace|makedirs|mkdir)\b|"
    r"shutil\.(?:copy\w*|move|rmtree)\b|\.(?:unlink|rmdir)\(")
_DAVID_CALL = re.compile(r'(?:^|[\s/;&|(])david\s+(?:run|ask|status)\b')


def is_david_call(command: str) -> bool:
    """The harness doing what the rule asks: calling david. Never denied."""
    return bool(_DAVID_CALL.search(command))


_REDIRECT_TARGET = re.compile(r'(?:^|[^0-9&<>=\-])>>?[ \t]*(?!&)([^\s|;&<>)]+)')


def analyze(command: str) -> tuple:
    """(kinds of write found, the targets of the plain `>` redirects). Kinds: code, redirect, verb, inplace, dd, git."""
    if not isinstance(command, str) or not command.strip():
        return set(), []
    kinds = set()
    if _CODE_WRITES.search(command):  # code in a heredoc or -c string writes files: look before the body is cut out
        kinds.add('code')
    flat = _QUOTED.sub("''", _HEREDOC.sub(r'<<HEREDOC\3', command))  # the body goes, the rest of its first line stays (> file)
    if _REDIRECT.search(flat) or _AMP_REDIRECT.search(flat):
        kinds.add('redirect')
    for kind, rx in (('verb', _VERBS), ('inplace', _INPLACE), ('dd', _DD), ('git', _GIT)):
        if rx.search(flat):
            kinds.add(kind)
    targets = [t for t in _REDIRECT_TARGET.findall(flat) if t != "''" and not t.startswith('/dev/null')]
    return kinds, targets


def command_modifies(command: str) -> bool:
    return bool(analyze(command)[0])


_CD = re.compile(r'\bcd\s+(?:"([^"]+)"|\'([^\']+)\'|([^\s;&|]+))')
_ABS = re.compile(r'(?:^|[\s=:\'"(])((?:~|/)[^\s\'"|;&<>)]*)')


def command_targets(command: str, cwd: str) -> list:
    """Directories and files a command can touch.

    A command whose only write is a plain `>` redirect touches exactly its redirect targets. Anything else can touch its
    cwd (unless it `cd`s somewhere first), every `cd`, and every absolute or ~ path it names.
    """
    base = cwd or os.getcwd()
    kinds, redirects = analyze(command)
    if kinds == {'redirect'} and redirects:
        raw = redirects
    else:
        cds = [next(g for g in m.groups() if g) for m in _CD.finditer(command)]
        raw = ([cwd] if cwd and not cds else []) + cds + [m.group(1) for m in _ABS.finditer(command)]
    resolved = []
    for t in raw:
        t = os.path.expanduser(t)
        resolved.append(t if os.path.isabs(t) else os.path.join(base, t))
    return resolved


# ---- the decision ---------------------------------------------------------------------------------------------------

FILE_TOOLS = ('edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'applypatch', 'str_replace_editor',
              'str_replace_based_edit_tool', 'create_file', 'update_file', 'delete_file')
SHELL_TOOLS = ('bash', 'shell', 'local_shell', 'exec_command', 'exec', 'run_shell_command', 'unified_exec',
               'container.exec')
_PATCH_PATH = re.compile(r'\*\*\* (?:Add|Update|Delete) File:\s*(.+)|\*\*\* Move to:\s*(.+)')


def _norm(name: str) -> str:
    return str(name or '').strip().lower().split('__')[-1]


def _patch_paths(args: dict) -> list:
    text = json.dumps(args, ensure_ascii=False).replace('\\n', '\n')
    return [next(g for g in m.groups() if g).strip().strip('"\\') for m in _PATCH_PATH.finditer(text)]


def _command_of(args: dict) -> str:
    cmd = args.get('command', args.get('cmd', ''))
    if isinstance(cmd, list):
        cmd = ' '.join(str(x) for x in cmd)
    return cmd if isinstance(cmd, str) else ''


def reason_to_deny(tool: str, args: dict, cwd: str = '', flavor: str = 'codex') -> 'str | None':
    """None = allow. Otherwise the sentence the harness reads as the tool's error."""
    name, args = _norm(tool), (args if isinstance(args, dict) else {})
    cwd = cwd or os.getcwd()
    repo = None
    if name in FILE_TOOLS:
        paths = [args.get(k) for k in ('file_path', 'filePath', 'path', 'notebook_path') if isinstance(args.get(k), str)]
        paths += _patch_paths(args)
        if not paths:
            paths = [cwd]  # a patch whose paths we cannot read: judge it by where it runs
        for p in paths:
            p = os.path.expanduser(p)
            repo = repo_of(p if os.path.isabs(p) else os.path.join(cwd, p))
            if repo:
                break
    elif name in SHELL_TOOLS:
        command = _command_of(args)
        if is_david_call(command) or not command_modifies(command):
            return None
        for t in command_targets(command, cwd):
            repo = repo_of(t)
            if repo:
                break
    if repo is None:
        return None
    return _deny_text(str(repo), flavor)


def _deny_text(repo: str, flavor: str) -> str:
    if flavor == 'deepseek':
        use = ('call david_run (changes) or david_ask (questions) instead; it plans, edits, tests and reviews with the right '
               'models and records the run')
    else:
        use = ('run ~/.david-force/bin/david run --cwd <repo> "<task>" (changes) or ~/.david-force/bin/david ask '
               '"<question>" (reads) instead; it plans, edits, tests and reviews with the right models')
    return (f'david-force is ON: do not change files in the git repository {repo} yourself. {use}. '
            'If david itself is down, run `david status`, fix that, and only then tell the owner; the owner turns this '
            'rule off with /david-force off.')

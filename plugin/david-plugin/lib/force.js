// david-force, DeepSeek Harness side: make the head agent use david instead of doing the work itself.
//
// The switch is the skill's state file (~/.david-force/state.json, written by `/david-force on|off`), read on every call, so
// toggling needs no restart. While it is ON:
//   1. a tool GUARD (ctx.tools.guard: synchronous, nothing can turn its denial back into permission) refuses edit, write
//      and file-changing bash for the HEAD agent when they touch a git repository. The model reads the denial as the tool's
//      error and calls david_run. The plugin's own workers are sub-agents and are never refused.
//   2. a system-prompt section states the rule (the model sees it on every request, which AGENTS.md does not guarantee).
//   3. a turn that made many direct tool calls and never called a david_* tool is sent back once before it may stop.
//
// The decision (what counts as "a write", where is "a repository") mirrors skill/david-force/scripts/common.py and is
// checked against the same table, skill/david-force/tests/commands.json, so Codex and DeepSeek agree.
// Everything fails open: a bug here must never be the reason a session cannot work.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const HOME = () => process.env.HOME || homedir();

export const forceHome = () => process.env.DAVID_FORCE_HOME || join(HOME(), ".david-force");

export function readState() {
  try {
    const s = JSON.parse(readFileSync(join(forceHome(), "state.json"), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export const HARNESSES = ["deepseek", "codex", "claude"];

/**
 * Is the rule ON for this harness? Each harness has its own switch ({"harnesses": {"deepseek": true, ...}}), so turning it on
 * for DeepSeek never reaches Codex or Claude Code. A state file from before that ({"on": true}) meant the DeepSeek harness.
 * Fail open: a missing or broken state file is OFF.
 */
export function enabled(harness) {
  if (process.env.DAVID_FORCE_OFF) return false;
  const st = readState();
  if (st.harnesses && typeof st.harnesses === "object") return st.harnesses[harness] === true;
  return harness === "deepseek" && st.on === true;
}

/** This plugin runs inside DeepSeek Harness, so its default is that harness's switch. */
export const isOn = (harness = "deepseek") => enabled(harness);

// ---- where direct edits are fine --------------------------------------------------------------------------------------

function realOf(p) {
  // realpath that also works for a path that does not exist yet: resolve the part that does, keep the rest
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const expand = (p) => (p === "~" ? HOME() : p.startsWith("~/") ? join(HOME(), p.slice(2)) : p);

function allowedPrefixes() {
  const home = HOME();
  const out = [".david-force", ".dsh", ".codex", ".claude", ".agents", ".backend-review"].map((d) => join(home, d));
  const tmp = process.env.DAVID_FORCE_TMP_ALLOW ?? "/tmp:/private/tmp:/var/folders:/private/var/folders";
  out.push(...tmp.split(":").filter(Boolean));
  try {
    for (const line of readFileSync(join(forceHome(), "allow.txt"), "utf8").split("\n")) {
      const l = line.trim();
      if (l && !l.startsWith("#")) out.push(expand(l));
    }
  } catch { /* no allow list */ }
  return out;
}

const under = (p, pre) => p === pre || p.startsWith(pre + sep);

/** The git work tree this path belongs to, or null when david has no business with it ($HOME as a repo does not count). */
export function repoOf(path) {
  let p;
  try {
    p = realOf(expand(String(path)));
  } catch {
    return null;
  }
  for (const pre of allowedPrefixes()) if (under(p, pre) || under(p, realOf(pre))) return null;
  const home = realOf(HOME());
  for (let cur = p; ; cur = dirname(cur)) {
    if (existsSync(join(cur, ".git"))) return cur === home ? null : cur;
    if (dirname(cur) === cur) return null;
  }
}

// ---- shell commands: does this one write? -----------------------------------------------------------------------------

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const REDIRECT = /(?:^|[^0-9&<>=\-])>>?(?!&)[ \t]*(?!\/dev\/null(?![\w/]))[^\s|;&<>)]/;
const AMP_REDIRECT = /&>>?[ \t]*(?!\/dev\/null(?![\w/]))[^\s|;&<>)]/;
const CMD_POS = "(?:^|[;&|(\\n`]\\s*|\\bsudo\\s+|\\bxargs\\s+(?:-\\S+\\s+)*)";
const VERBS = new RegExp(`${CMD_POS}(?:mv|cp|rm|rmdir|touch|mkdir|ln|truncate|chmod|chown|patch|tee|install|rsync|unlink)\\b`);
const INPLACE = /\b(?:sed|perl)\b[^|;&\n]*\s(?:-[A-Za-z]*i\b|--in-place\b)/;
const DD = /\bdd\b[^|;&\n]*\bof=/;
const GIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|add|apply|am|checkout|switch|restore|reset|revert|merge|rebase|cherry-pick|stash|pull|clean|rm|mv|push|tag|worktree|init|clone)\b/;
const CODE_WRITES = /open\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]|\.write_text\(|\.write_bytes\(|writeFileSync|appendFileSync|\bwriteFile\(|\bappendFile\(|fs\.write|createWriteStream|os\.(?:remove|unlink|rename|replace|makedirs|mkdir)\b|shutil\.(?:copy\w*|move|rmtree)\b|\.(?:unlink|rmdir)\(/;
const DAVID_CALL = /(?:^|[\s/;&|(])david\s+(?:run|ask|status)\b/;
const REDIRECT_TARGET = /(?:^|[^0-9&<>=\-])>>?[ \t]*(?!&)([^\s|;&<>)]+)/g;

/** The harness doing what the rule asks: calling david. Never refused. */
export const isDavidCall = (command) => DAVID_CALL.test(command);

/** { kinds, redirects }: which kinds of write the command contains, and where its plain `>` redirects point. */
export function analyze(command) {
  if (typeof command !== "string" || !command.trim()) return { kinds: new Set(), redirects: [] };
  const kinds = new Set();
  if (CODE_WRITES.test(command)) kinds.add("code");
  const flat = command.replace(HEREDOC, "<<HEREDOC$3").replace(QUOTED, "''");
  if (REDIRECT.test(flat) || AMP_REDIRECT.test(flat)) kinds.add("redirect");
  for (const [kind, rx] of [["verb", VERBS], ["inplace", INPLACE], ["dd", DD], ["git", GIT]]) if (rx.test(flat)) kinds.add(kind);
  const redirects = [...flat.matchAll(REDIRECT_TARGET)].map((m) => m[1]).filter((t) => t !== "''" && !t.startsWith("/dev/null"));
  return { kinds, redirects };
}

export const commandModifies = (command) => analyze(command).kinds.size > 0;

const CD = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
const ABS = /(?:^|[\s=:'"(])((?:~|\/)[^\s'"|;&<>)]*)/g;

/** Directories and files a command can touch (a pure `>` redirect touches only its targets). */
export function commandTargets(command, cwd) {
  const base = cwd || process.cwd();
  const { kinds, redirects } = analyze(command);
  let raw;
  if (kinds.size === 1 && kinds.has("redirect") && redirects.length) {
    raw = redirects;
  } else {
    const cds = [...command.matchAll(CD)].map((m) => m[1] ?? m[2] ?? m[3]);
    raw = [...(cwd && !cds.length ? [cwd] : []), ...cds, ...[...command.matchAll(ABS)].map((m) => m[1])];
  }
  return raw.map((t) => {
    const e = expand(t);
    return isAbsolute(e) ? e : join(base, e);
  });
}

// ---- the decision -------------------------------------------------------------------------------------------------------

const FILE_TOOLS = ["edit", "write", "multiedit", "notebookedit", "apply_patch", "applypatch", "str_replace_editor", "str_replace_based_edit_tool", "create_file", "update_file", "delete_file"];
const SHELL_TOOLS = ["bash", "shell", "local_shell", "exec_command", "exec", "run_shell_command", "unified_exec", "container.exec"];
const PATCH_PATH = /\*\*\* (?:Add|Update|Delete) File:\s*(.+)|\*\*\* Move to:\s*(.+)/g;

const norm = (name) => String(name ?? "").trim().toLowerCase().split("__").pop();

function patchPaths(args) {
  const text = JSON.stringify(args).replace(/\\n/g, "\n");
  return [...text.matchAll(PATCH_PATH)].map((m) => (m[1] ?? m[2]).trim().replace(/^["\\]+|["\\]+$/g, ""));
}

function commandOf(args) {
  let cmd = args.command ?? args.cmd ?? "";
  if (Array.isArray(cmd)) cmd = cmd.join(" ");
  return typeof cmd === "string" ? cmd : "";
}

/** undefined = allow; otherwise the sentence the model reads as the tool's error. */
export function reasonToDeny(tool, args, cwd = "", flavor = "deepseek") {
  const name = norm(tool);
  const a = args && typeof args === "object" ? args : {};
  const where = cwd || process.cwd();
  let repo = null;
  if (FILE_TOOLS.includes(name)) {
    let paths = ["file_path", "filePath", "path", "notebook_path"].map((k) => a[k]).filter((v) => typeof v === "string");
    paths.push(...patchPaths(a));
    if (!paths.length) paths = [where]; // a patch whose paths we cannot read is judged by where it runs
    for (const p of paths) {
      const e = expand(p);
      repo = repoOf(isAbsolute(e) ? e : join(where, e));
      if (repo) break;
    }
  } else if (SHELL_TOOLS.includes(name)) {
    const command = commandOf(a);
    if (isDavidCall(command) || !commandModifies(command)) return undefined;
    for (const t of commandTargets(command, where)) {
      repo = repoOf(t);
      if (repo) break;
    }
  }
  return repo ? denyText(repo, flavor) : undefined;
}

function denyText(repo, flavor) {
  const use = flavor === "deepseek"
    ? "call david_run (changes) or david_ask (questions) instead; it plans, edits, tests and reviews with the right models and records the run"
    : 'run ~/.david-force/bin/david run --cwd <repo> "<task>" (changes) or ~/.david-force/bin/david ask "<question>" (reads) instead; it plans, edits, tests and reviews with the right models';
  return `david-force is ON: do not change files in the git repository ${repo} yourself. ${use}. If david itself is down, run david_probe, fix that, and only then tell the owner; the owner turns this rule off with /david-force off.`;
}

// ---- wiring into the Harness ----------------------------------------------------------------------------------------------

export const PROMPT = [
  "david-force is ON (the owner's rule for this machine).",
  "- Every change to files in a git repository goes through the david_run tool. You cannot edit, write or run file-changing shell commands inside a repository yourself: the call is refused.",
  "- Every search, lookup or investigation that would take more than a few reads goes through david_ask, not a chain of your own tool calls.",
  "- Your own tools are for the quick lookup, for files outside any repository (~/.dsh, ~/.codex, ~/.claude, ~/.agents) and for decisions.",
  "- If david itself is down (david_probe), say so in one sentence and let the owner decide; do not work around the rule.",
].join("\n");

/** A head agent is one whose session header says it is not a sub-agent. Unknown shape => not head => nothing is refused. */
export function isHead(agent) {
  const h = agent?.session?.header;
  if (!h || typeof h !== "object") return false;
  return h.origin !== "subagent" && h.parentSession === undefined && !((h.delegationDepth ?? 0) > 0);
}

const DIRECT_LIMIT = 6;

export function applyForce(ctx, { log = () => {}, name = "david-plugin" } = {}) {
  const disposers = [];
  const when = (deps, fn) => (typeof ctx.inject === "function" ? ctx.inject(deps, fn) : fn(ctx));

  // 1. the guard
  if (typeof ctx.tools?.guard === "function") {
    disposers.push(ctx.tools.guard((exec) => {
      try {
        if (!isOn() || !isHead(exec?.agent)) return undefined;
        return reasonToDeny(exec.name, exec.arguments, exec.agent.session.header.cwd ?? "", "deepseek");
      } catch {
        return undefined;
      }
    }));
  } else {
    log("force: this Harness has no ctx.tools.guard(); the rule is only in the prompt");
  }

  // 2. the system-prompt section, present exactly while the rule is ON. The service lives on the context that
  // ctx.inject() hands to its callback, not on this plugin's own ctx, so it is taken from there.
  let section;
  let prompts = typeof ctx.inject === "function" ? null : ctx; // no ctx.inject (a bare test ctx): the services are on ctx
  const sync = () => {
    const on = isOn();
    if (on && !section && prompts?.systemPrompt?.section) {
      section = prompts.systemPrompt.section({ name: "david-force", order: 5, text: PROMPT });
      if (section === undefined) section = true; // registered, no disposer handed back
      log("force: system-prompt rule added");
    } else if (!on && section) {
      try { if (typeof section === "function") section(); else section.dispose?.(); } catch { /* already gone */ }
      section = undefined;
      log("force: system-prompt rule removed");
    }
  };
  when(["systemPrompt"], (c) => {
    prompts = c;
    sync();
    const timer = setInterval(sync, 1500);
    timer.unref?.();
    disposers.push(() => clearInterval(timer));
  });

  // 3. a turn of direct work that never called david is sent back once
  const turns = new WeakMap(); // agent -> { direct, david, steered }
  const turnOf = (agent) => (turns.has(agent) ? turns.get(agent) : (turns.set(agent, { direct: 0, david: 0, steered: false }), turns.get(agent)));
  when(["agents"], (c) => {
    c.on("session/event", (session, event) => {
      try {
        const agent = c.agents?.get(session.id);
        if (agent === undefined || agent.session !== session || !isHead(agent)) return;
        if (event.type === "user/message" && event.data?.source?.kind === "user") Object.assign(turnOf(agent), { direct: 0, david: 0, steered: false });
        else if (event.type === "tool/call") {
          const t = turnOf(agent);
          if (String(event.data?.name ?? "").startsWith("david_")) t.david += 1;
          else t.direct += 1;
        }
      } catch { /* counting is best effort */ }
    });
    c.on("agent/turn-stopping", ({ agent, signal } = {}) => {
      try {
        if (!isOn() || signal?.aborted || !isHead(agent)) return;
        const t = turnOf(agent);
        if (t.steered || t.david > 0 || t.direct < DIRECT_LIMIT) return;
        t.steered = true;
        agent.steer({ content: [{ type: "text", text: `david-force is ON: this turn made ${t.direct} direct tool calls and never called david. Do what is left through david_ask (anything you still need to find out) or david_run (any change); if david cannot do it, say exactly why in your answer instead of doing it by hand.` }], source: { kind: name } });
      } catch { /* the turn ends as it would have */ }
    });
  });

  return { sync, dispose: () => { while (disposers.length) disposers.pop()(); } };
}


import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROMPT, analyze, applyForce, commandModifies, enabled, isHead, isOn, reasonToDeny } from "../../plugin/david-plugin/lib/force.js";

const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../skill/david-force/tests/commands.json", import.meta.url)), "utf8"));

// A fake machine: its own HOME and state folder, a repo with a .git folder, a folder that is not a repo.
const root = mkdtempSync(join(tmpdir(), "david-"));
const home = join(root, "home");
const repo = join(home, "work", "repo");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(home, ".dsh"), { recursive: true });
mkdirSync(join(home, "loose"), { recursive: true });
Object.assign(process.env, { HOME: home, DAVID_FORCE_HOME: join(root, "state"), DAVID_FORCE_TMP_ALLOW: "" });
delete process.env.DAVID_FORCE_OFF;
const setOn = (on) => { mkdirSync(process.env.DAVID_FORCE_HOME, { recursive: true }); writeFileSync(join(process.env.DAVID_FORCE_HOME, "state.json"), JSON.stringify({ on })); };

test("force: the command table that Codex's Python hook also passes (one definition of 'a write')", () => {
  const wrong = CASES.filter((c) => commandModifies(c.cmd) !== c.modifies).map((c) => c.cmd);
  assert.deepEqual(wrong, []);
});

test("force: the state file is the switch, a broken one is OFF, and DAVID_FORCE_OFF wins", () => {
  assert.equal(isOn(), false, "no file");
  mkdirSync(process.env.DAVID_FORCE_HOME, { recursive: true });
  writeFileSync(join(process.env.DAVID_FORCE_HOME, "state.json"), "{not json");
  assert.equal(isOn(), false);
  setOn(true);
  assert.equal(isOn(), true);
  process.env.DAVID_FORCE_OFF = "1";
  assert.equal(isOn(), false);
  delete process.env.DAVID_FORCE_OFF;
  setOn(false);
  assert.equal(isOn(), false);
});

test("force: a write inside a repository is refused with the way out; reads, david and non-repos are not", () => {
  const deny = (tool, args, cwd = repo) => reasonToDeny(tool, args, cwd);
  assert.match(deny("bash", { command: "echo x > src/a.js" }), /david-force is ON.*david_run/s);
  assert.match(deny("edit", { file_path: join(repo, "src", "a.js") }, home), /git repository/);
  assert.match(deny("write", { file_path: "src/new.js" }), /git repository/, "a relative path is resolved against the cwd");
  assert.ok(deny("bash", { command: `cd ${repo} && sed -i '' s/a/b/ src/a.js` }, home));
  for (const cmd of ["ls src", "git status", "grep -rn foo .", 'david_run is a tool, not a command; ls', "~/.david-force/bin/david run --cwd . 'fix' > out.txt"]) {
    assert.equal(deny("bash", { command: cmd }), undefined, cmd);
  }
  assert.equal(deny("bash", { command: "echo x > a.txt" }, join(home, "loose")), undefined, "not a repository");
  assert.equal(deny("write", { file_path: join(home, ".dsh", "x.md") }), undefined, "the owner's config folders");
  assert.equal(deny("bash", { command: "echo x > ~/.dsh/AGENTS.md" }), undefined, "a plain redirect is judged by where it writes");
  assert.equal(deny("bash", { command: "cd ~/.dsh && sed -i '' s/a/b/ AGENTS.md" }), undefined, "a cd leaves the repo");
  assert.ok(deny("bash", { command: "cp /tmp/a.js src/a.js" }), "a verb with a relative target counts the cwd");
  assert.equal(deny("read", { file_path: join(repo, "src", "a.js") }), undefined);
  assert.equal(deny("mcp__slack__send", { text: "hi" }), undefined);
  assert.equal(reasonToDeny("bash", null, ""), undefined);
  assert.equal(reasonToDeny("bash", { command: null }, repo), undefined);
});

test("force: a repo rooted at HOME does not count, and an allow.txt line adds a folder", () => {
  mkdirSync(join(home, ".git"));
  assert.equal(reasonToDeny("bash", { command: "echo x > a.txt" }, join(home, "loose")), undefined);
  assert.ok(reasonToDeny("bash", { command: "echo x > a.txt" }, repo), "the real repo below it still counts");
  writeFileSync(join(process.env.DAVID_FORCE_HOME, "allow.txt"), `# mine\n${repo}\n`);
  assert.equal(reasonToDeny("bash", { command: "echo x > a.txt" }, repo), undefined);
  writeFileSync(join(process.env.DAVID_FORCE_HOME, "allow.txt"), "");
});

test("force: apply_patch paths are read from the patch text", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch\n";
  assert.ok(reasonToDeny("apply_patch", { input: patch }, repo));
  assert.equal(reasonToDeny("apply_patch", { input: `*** Begin Patch\n*** Add File: ${home}/.dsh/n.md\n+x\n*** End Patch\n` }, home), undefined);
});

test("force: analyze names the kinds of write and the redirect targets", () => {
  assert.deepEqual([...analyze("echo x > a.txt").kinds], ["redirect"]);
  assert.deepEqual(analyze("echo x > a.txt 2>&1").redirects, ["a.txt"]);
  assert.deepEqual([...analyze("rm a && echo x > b").kinds].sort(), ["redirect", "verb"]);
  assert.equal(analyze("").kinds.size, 0);
});

test("force: only a head agent is ever refused; an agent whose header we cannot read is left alone", () => {
  assert.equal(isHead({ session: { header: { id: "s" } } }), true);
  assert.equal(isHead({ session: { header: { origin: "subagent", delegationDepth: 1 } } }), false);
  assert.equal(isHead({ session: { header: { parentSession: "p" } } }), false);
  assert.equal(isHead({ session: { header: { delegationDepth: 2 } } }), false);
  assert.equal(isHead({}), false, "unknown shape: fail open, so the workers can never be blocked by a wrong guess");
  assert.equal(isHead(undefined), false);
});

function fakeCtx({ withSystemPrompt = true, withGuard = true } = {}) {
  const handlers = new Map();
  const sections = [];
  const guards = [];
  const agents = new Map();
  const ctx = {
    on: (ev, fn) => handlers.set(ev, fn),
    agents: { get: (id) => agents.get(id) },
    tools: withGuard ? { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) } : {},
    ...(withSystemPrompt ? { systemPrompt: { section: (s) => (sections.push(s), () => sections.splice(sections.indexOf(s), 1)) } } : {}),
  };
  return { ctx, handlers, sections, guards, agents };
}
const head = (cwd = repo) => ({ session: { header: { id: "h", cwd } } });
const child = (cwd = repo) => ({ session: { header: { id: "c", cwd, origin: "subagent", delegationDepth: 1 } } });

test("force guard: refuses the head's write in a repo while ON, never the worker's, never while OFF", () => {
  const f = fakeCtx();
  const force = applyForce(f.ctx);
  try {
    const run = (agent, name, args) => f.guards[0]({ name, arguments: args, agent });
    setOn(false);
    assert.equal(run(head(), "edit", { file_path: join(repo, "src", "a.js") }), undefined, "OFF");
    setOn(true);
    assert.match(run(head(), "edit", { file_path: join(repo, "src", "a.js") }), /david-force is ON/);
    assert.match(run(head(), "bash", { command: "git commit -am x" }), /david_run/);
    assert.equal(run(child(), "edit", { file_path: join(repo, "src", "a.js") }), undefined, "the plugin's own worker must be able to edit");
    assert.equal(run(head(), "read", { file_path: join(repo, "src", "a.js") }), undefined);
    assert.equal(run(head(), "david_run", { task: "t", cwd: repo }), undefined);
    assert.equal(run(undefined, "edit", { file_path: join(repo, "src", "a.js") }), undefined, "no agent: not ours to judge");
    assert.equal(f.guards[0]({ name: "edit", arguments: { file_path: repo }, agent: { session: { get header() { throw new Error("boom"); } } } }), undefined, "a throwing accessor never denies");
  } finally { force.dispose(); setOn(false); }
  assert.equal(f.guards.length, 0, "dispose removes the guard");
});

test("force prompt: the system-prompt section exists exactly while the rule is ON", () => {
  const f = fakeCtx();
  setOn(false);
  const force = applyForce(f.ctx);
  try {
    assert.equal(f.sections.length, 0);
    setOn(true); force.sync();
    assert.equal(f.sections.length, 1);
    assert.equal(f.sections[0].name, "david-force");
    assert.equal(f.sections[0].text, PROMPT);
    force.sync();
    assert.equal(f.sections.length, 1, "not registered twice");
    setOn(false); force.sync();
    assert.equal(f.sections.length, 0);
  } finally { force.dispose(); setOn(false); }
});

test("force: a Harness without guard() or systemPrompt is not an error", () => {
  const logs = [];
  const f = fakeCtx({ withGuard: false, withSystemPrompt: false });
  const force = applyForce(f.ctx, { log: (m) => logs.push(m) });
  setOn(true);
  assert.doesNotThrow(() => force.sync());
  assert.match(logs.join(" "), /no ctx\.tools\.guard/);
  force.dispose(); setOn(false);
});

test("force steer: a turn of direct work that never called david is sent back once, and a new message resets it", () => {
  const f = fakeCtx();
  const force = applyForce(f.ctx);
  const steers = [];
  const agent = { ...head(), steer: (m) => steers.push(m) };
  agent.session.id = "s1";
  f.agents.set("s1", agent);
  const ev = (type, data) => f.handlers.get("session/event")(agent.session, { type, data });
  const stop = () => f.handlers.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
  try {
    setOn(true);
    ev("user/message", { source: { kind: "user" } });
    for (let i = 0; i < 6; i++) ev("tool/call", { name: "bash" });
    stop();
    assert.equal(steers.length, 1);
    assert.match(steers[0].content[0].text, /6 direct tool calls/);
    assert.equal(steers[0].source.kind, "david-plugin");
    stop();
    assert.equal(steers.length, 1, "once per turn");
    ev("user/message", { source: { kind: "user" } });
    for (let i = 0; i < 6; i++) ev("tool/call", { name: "read" });
    ev("tool/call", { name: "david_ask" });
    stop();
    assert.equal(steers.length, 1, "a turn that called david is left alone");
    ev("user/message", { source: { kind: "user" } });
    for (let i = 0; i < 3; i++) ev("tool/call", { name: "read" });
    stop();
    assert.equal(steers.length, 1, "a short turn is left alone");
    setOn(false);
    ev("user/message", { source: { kind: "user" } });
    for (let i = 0; i < 9; i++) ev("tool/call", { name: "bash" });
    stop();
    assert.equal(steers.length, 1, "OFF steers nothing");
    // a worker's events are never counted
    setOn(true);
    const w = { ...child(), steer: (m) => steers.push(m) };
    w.session.id = "w1";
    f.agents.set("w1", w);
    for (let i = 0; i < 9; i++) f.handlers.get("session/event")(w.session, { type: "tool/call", data: { name: "bash" } });
    f.handlers.get("agent/turn-stopping")({ agent: w, signal: {} });
    assert.equal(steers.length, 1);
  } finally { force.dispose(); setOn(false); }
});

test("force prompt: the service is taken from the context ctx.inject hands over (it is not on the plugin's own ctx)", () => {
  const sections = [];
  const injected = { systemPrompt: { section: (s) => (sections.push(s), () => sections.splice(sections.indexOf(s), 1)) }, agents: { get: () => undefined }, on: () => {} };
  // the real shape: the plugin's own ctx has no systemPrompt; ctx.inject(deps, fn) calls fn with a context that does
  const ctx = { tools: { guard: () => () => {} }, inject: (deps, fn) => fn(injected) };
  setOn(true);
  const force = applyForce(ctx);
  try {
    assert.equal(sections.length, 1, "the rule reached the system prompt");
    setOn(false); force.sync();
    assert.equal(sections.length, 0);
    setOn(true); force.sync();
    assert.equal(sections.length, 1);
  } finally { force.dispose(); setOn(false); }
});

test("force: each harness has its own switch; DeepSeek on never reaches Codex or Claude, and the old single switch meant DeepSeek", () => {
  const write = (o) => { mkdirSync(process.env.DAVID_FORCE_HOME, { recursive: true }); writeFileSync(join(process.env.DAVID_FORCE_HOME, "state.json"), JSON.stringify(o)); };
  write({ on: true, harnesses: { deepseek: true, codex: false, claude: false } });
  assert.deepEqual(["deepseek", "codex", "claude"].map(enabled), [true, false, false]);
  assert.equal(isOn(), true, "this plugin runs in DeepSeek Harness: its default is that switch");
  write({ on: true, harnesses: { deepseek: false, codex: true, claude: true } });
  assert.deepEqual(["deepseek", "codex", "claude"].map(enabled), [false, true, true]);
  assert.equal(isOn(), false, "Codex and Claude on does not govern the DeepSeek harness");
  write({ on: true });
  assert.deepEqual(["deepseek", "codex", "claude"].map(enabled), [true, false, false], "a state file from before the switches");
  process.env.DAVID_FORCE_OFF = "1";
  assert.equal(enabled("deepseek"), false);
  delete process.env.DAVID_FORCE_OFF;
  setOn(false);
});

test("force guard: with only Codex switched on, the DeepSeek head is not refused", () => {
  const f = fakeCtx();
  const force = applyForce(f.ctx);
  try {
    mkdirSync(process.env.DAVID_FORCE_HOME, { recursive: true });
    writeFileSync(join(process.env.DAVID_FORCE_HOME, "state.json"), JSON.stringify({ on: true, harnesses: { deepseek: false, codex: true, claude: false } }));
    assert.equal(f.guards[0]({ name: "edit", arguments: { file_path: join(repo, "src", "a.js") }, agent: head() }), undefined);
    writeFileSync(join(process.env.DAVID_FORCE_HOME, "state.json"), JSON.stringify({ on: true, harnesses: { deepseek: true, codex: false, claude: false } }));
    assert.match(f.guards[0]({ name: "edit", arguments: { file_path: join(repo, "src", "a.js") }, agent: head() }), /david-force is ON/);
  } finally { force.dispose(); setOn(false); }
});

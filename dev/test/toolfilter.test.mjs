import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTool, denyFor } from "../../plugin/jev-orchestrator/index.js";
import { Ledger } from "../../plugin/jev-orchestrator/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/jev-orchestrator/lib/config.js";
import { ToolFilter, refusedNames } from "../../plugin/jev-orchestrator/lib/toolfilter.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));
// verbatim from ~/.dsh/jev-runs.jsonl on the desktop profile (list shortened)
const REAL = 'tools.restrict() names unknown global tool "subagent"; known global tools: ask_user_question, bash, create_goal, edit, exit_plan_mode';

test("refusedNames reads the names from the Harness's own message", () => {
  assert.deepEqual(refusedNames(new Error(REAL)), ["subagent"]);
  assert.deepEqual(refusedNames(new Error('tools.restrict() names unknown global tools "a", "b"; known global tools: x')), ["a", "b"]);
  assert.deepEqual(refusedNames(REAL), ["subagent"], "a bare string works too");
  assert.deepEqual(refusedNames(new Error("quota exceeded")), []);
  assert.deepEqual(refusedNames(undefined), []);
  assert.deepEqual(refusedNames(new Error('something else: tools.restrict() names unknown global tool "x"; known global tools: y')), [], "must match the whole message, not a fragment");
});

test("ToolFilter only drops names it actually sent, and remembers them", () => {
  const f = new ToolFilter(DEFAULTS);
  assert.deepEqual(f.deny("worker"), DEFAULTS.childTools.denyAll);
  assert.deepEqual(f.learn(new Error('tools.restrict() names unknown global tool "not_ours"; known global tools: x'), f.deny("worker")), [], "a name we never sent is not ours to drop");
  assert.deepEqual(f.learn(new Error(REAL), f.deny("worker")), ["subagent"]);
  assert.ok(!f.deny("worker").includes("subagent") && f.deny("worker").includes("jev_run"));
  assert.deepEqual(f.learn(new Error(REAL), f.deny("worker")), [], "this attempt no longer sends it: nothing to learn, so the caller must rethrow");
  const stale = ["jev_run", "subagent"]; // a sibling's attempt that started before the name was learned
  assert.deepEqual(f.learn(new Error(REAL), stale), ["subagent"], "a stale attempt must still be told to retry");
  assert.ok(!f.deny("reviewer").includes("subagent"), "learned for every role");
  assert.ok(f.deny("reviewer").includes("write"));
});

function fakeCtx({ refuse = [], other } = {}) {
  const starts = [];
  return {
    starts,
    subagents: {
      resolveMaxDepth: () => 1,
      async start(_p, req) {
        starts.push(req.toolFilter.deny);
        if (other) throw other;
        const bad = req.toolFilter.deny.filter((n) => refuse.includes(n));
        if (bad.length) throw new Error(`tools.restrict() names unknown global tool${bad.length > 1 ? "s" : ""} ${bad.map((n) => `"${n}"`).join(", ")}; known global tools: bash, read`);
        return { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }), dispose() {} };
      },
    },
  };
}
const exec = () => ({ agent: {}, signal: new AbortController().signal });
const toolFor = (ctx, over = {}) => {
  const cfg = resolveConfig({ laya: { enabled: false }, runLog: join(tmp(), "r.jsonl"), limits: { startGapMs: { cursor: 0 } }, ...over });
  return buildTool(ctx, cfg, new Ledger(join(tmp(), "l.json"), cfg.budgets));
};
const run = (tool) => tool.execute({ task: "t", cwd: "/definitely/not/a/repo", plan: "no" }, exec()).catch((e) => `ERR ${e.message}`);

test("a refused filter name no longer kills the child: it is dropped and the child starts (the 0.5.0 desktop bug)", async () => {
  const ctx = fakeCtx({ refuse: ["subagent"] });
  const out = await run(toolFor(ctx));
  assert.equal(ctx.starts.length, 2, "first start refused, second start accepted");
  assert.ok(ctx.starts[0].includes("subagent") && !ctx.starts[1].includes("subagent"));
  assert.ok(ctx.starts[1].includes("jev_run"), "the guard on names the Harness accepts must stay");
  assert.ok(!/every route failed/.test(out), "the worker must not be reported as dead");
});

test("every name the Harness refuses is dropped, including several at once", async () => {
  const ctx = fakeCtx({ refuse: ["subagent", "subagent_fork", "workflow"] });
  await run(toolFor(ctx));
  assert.deepEqual(ctx.starts.at(-1), ["jev_run"]);
});

test("the refusal is learned once per tool: later children start straight away", async () => {
  const ctx = fakeCtx({ refuse: ["subagent"] });
  const tool = toolFor(ctx);
  await run(tool);
  const before = ctx.starts.length;
  await run(tool);
  assert.equal(ctx.starts.length - before, 1, "no refused attempt the second time");
});

test("what was learned does not leak into another tool instance", async () => {
  const tool1 = toolFor(fakeCtx({ refuse: ["subagent"] }));
  await run(tool1);
  const ctx2 = fakeCtx({ refuse: ["subagent"] });
  await run(toolFor(ctx2));
  assert.equal(ctx2.starts.length, 2, "a fresh instance starts with the full filter again");
});

test("an unrelated start error is not swallowed or retried", async () => {
  const ctx = fakeCtx({ other: new Error("quota exceeded") });
  const out = await run(toolFor(ctx));
  assert.deepEqual(ctx.starts.map((d) => d.includes("subagent")), [true, true], "one attempt per route (primary and backup), no retry");
  assert.match(out, /quota exceeded/);
});

function realRepo() {
  const dir = tmp();
  const git = (...a) => execFileSync("git", a, { cwd: dir });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "x\n"); git("add", "-A"); git("commit", "-qm", "init");
  return dir;
}

test("the report says the filter got weaker, exactly once even with several children", async () => {
  const ctx = fakeCtx({ refuse: ["subagent"] });
  const out = await toolFor(ctx).execute({ task: "t", cwd: realRepo(), tasks: ["a", "b", "c"], plan: "no" }, exec());
  assert.match(out, /^jev_run: done/);
  const notes = out.match(/child tool filter: this Harness does not let a filter name "subagent"/g) ?? [];
  assert.equal(notes.length, 1, `expected one note, got ${notes.length}:\n${out}`);
  assert.match(out, /the depth limit still stops them from delegating/);
});

test("no note when the Harness accepts the whole filter", async () => {
  const out = await toolFor(fakeCtx()).execute({ task: "t", cwd: realRepo(), plan: "no" }, exec());
  assert.ok(!/child tool filter/.test(out));
});

test("denyFor is still exported and unchanged for callers", () => {
  assert.deepEqual(denyFor(DEFAULTS, "worker"), ["jev_run", "subagent", "subagent_fork", "workflow"]);
  assert.ok(denyFor(DEFAULTS, "reviewer").includes("write"));
});

test("workers that start together are all rescued: none falls back to the backup route (race: the filter is learned while a sibling is already refused)", async () => {
  const ctx = fakeCtx({ refuse: ["subagent"] });
  const out = await toolFor(ctx).execute({ task: "t", cwd: realRepo(), tasks: ["a", "b", "c"], plan: "no" }, exec());
  assert.match(out, /^jev_run: done/);
  assert.ok(!/FAILED/.test(out), `a sibling worker died instead of retrying:\n${out}`);
  assert.ok(!/backup/.test(out.split("Notes:")[0]), "no worker should have needed the backup route");
  assert.match(out, /worker-3 -> router9\/cursor-workers \[cursor\]/);
});

import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTool, denyFor } from "../../plugin/david-plugin/index.js";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/david-plugin/lib/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));

test("children never get the tools that start more agents; non-workers also lose write/edit", () => {
  const w = denyFor(DEFAULTS, "worker");
  for (const t of ["jev_run", "subagent", "subagent_fork", "workflow"]) assert.ok(w.includes(t), `worker must not get ${t}`);
  assert.ok(!w.includes("write") && !w.includes("edit"));
  for (const role of ["planner", "researcher", "reviewer", "final_reviewer"]) {
    const d = denyFor(DEFAULTS, role);
    assert.ok(d.includes("write") && d.includes("edit") && d.includes("jev_run"), role);
  }
  assert.deepEqual(denyFor(resolveConfig({ childTools: { denyAll: ["x"] } }), "worker"), ["x"]);
  assert.equal(DEFAULTS.childTools.denyAll.length, 4); // defaults not mutated by denyFor
});

function fakeCtx() {
  const starts = [];
  return {
    starts,
    subagents: {
      resolveMaxDepth: () => 1,
      start: async (_p, req) => (starts.push(req), { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }), dispose() {} }),
    },
  };
}

test("every child start carries the tool filter and the cd instruction", async () => {
  const ctx = fakeCtx();
  const cfg = resolveConfig({ laya: { enabled: false }, runLog: join(tmp(), "r.jsonl") });
  const tool = buildTool(ctx, cfg, new Ledger(join(tmp(), "l.json"), cfg.budgets));
  await tool.execute({ task: "t", cwd: "/definitely/not/a/repo", plan: "no" }, { agent: {}, signal: new AbortController().signal }).catch(() => {});
  assert.equal(ctx.starts.length, 1);
  assert.deepEqual(ctx.starts[0].toolFilter, { deny: denyFor(cfg, "worker") });
  const text = ctx.starts[0].prompt[0].text;
  assert.match(text, /Your shell does NOT start there/);
  assert.match(text, /cd \/definitely\/not\/a\/repo && <command>/);
});

test("who.mjs prints output even when run through a symlinked path (macOS /tmp)", () => {
  const dir = tmp();
  const real = join(dir, "real");
  mkdirSync(real);
  const src = fileURLToPath(new URL("../../plugin/david-plugin/who.mjs", import.meta.url));
  writeFileSync(join(real, "who.mjs"), execFileSync("cat", [src], { encoding: "utf8" }));
  symlinkSync(real, join(dir, "link"));
  const log = join(dir, "runs.jsonl");
  writeFileSync(log, JSON.stringify({ ts: "2026-10-06T10:00:00.000Z", end: "2026-10-06T10:00:05.000Z", status: "done", cwd: "/r", task: "t", trace: [] }) + "\n");
  const out = execFileSync("node", [join(dir, "link", "who.mjs"), "1"], { encoding: "utf8", env: { ...process.env, JEV_RUN_LOG: log, ROUTER9_DB: "/nonexistent" } });
  assert.match(out, /2026-10-06T10:00:00\.000Z {2}done {2}\/r/);
});

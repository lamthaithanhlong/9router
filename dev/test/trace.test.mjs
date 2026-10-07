import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/david-plugin/lib/config.js";
import { formatReport, formatTrace, runPipeline } from "../../plugin/david-plugin/lib/pipeline.js";
import { recordRun } from "../../plugin/david-plugin/lib/runlog.js";
import { formatRun, readRuns, router9Window, windowSql } from "../../plugin/david-plugin/who.mjs";
import { buildTool } from "../../plugin/david-plugin/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));
const SMALL = { files: [{ path: "src/a.js", added: 5, removed: 1 }], diff: "d" };
const RISKY = { files: [{ path: "src/auth/x.js", added: 5, removed: 1 }], diff: "d" };

function deps(over = {}) {
  return {
    cfg: DEFAULTS,
    ledger: new Ledger(join(tmp(), "l.json"), DEFAULTS.budgets),
    laya: { noul: async () => over.laya ?? 0.1 },
    log: () => {},
    loadPrompt: (r) => `ROLE: ${r}`,
    spawn: async () => (over.reply ?? '{"verdict":"approve","issues":[]}'),
    getChanges: async () => over.changes ?? SMALL,
    runTests: async () => ({ passed: true, summary: "", ran: true }),
  };
}
const input = { task: "fix the bug", cwd: "/repo", tasks: ["fix the bug"], research: [], allowedPaths: ["src/**"], testCommand: "t", plan: "auto", finalReview: false };

test("trace: a simple run lists Laya and the worker, and names the roles that did not run", async () => {
  const out = await runPipeline(deps(), input);
  assert.deepEqual(out.trace.map((e) => `${e.role}:${e.key}`), ["laya:laya", "worker:cursor"]);
  const w = out.trace.find((e) => e.role === "worker");
  assert.equal(`${w.provider}/${w.model}`, "router9/cursor-workers");
  assert.ok(w.ms >= 0 && w.tokensIn > 0);
  const lines = formatTrace(out.trace);
  assert.match(lines.join("\n"), /laya needs_plan: p=0\.1/);
  assert.match(lines.join("\n"), /worker-1 -> router9\/cursor-workers \[cursor\]/);
  assert.match(lines.at(-1), /not called: planner, researcher, reviewer, final_reviewer/);
});

test("trace: a risky run shows DeepSeek and Codex, with the route key", async () => {
  const out = await runPipeline(deps({ changes: RISKY }), { ...input, plan: "no" });
  const keys = out.trace.map((e) => e.key);
  assert.deepEqual(keys, ["cursor", "deepseek", "codex"]);
  const text = formatReport(out, RISKY);
  assert.match(text, /Who ran:/);
  assert.match(text, /reviewer -> deepseek-host\/deepseek-v4\.1-flash \[deepseek\]/);
  assert.match(text, /final-reviewer -> router9\/codex-head \[codex\]/);
});

test("trace: fallback, backup and failure are marked, with the reason", async () => {
  // reviewer chain exhausted on budget -> the reviewer runs on the backup route (and is tagged as such)
  const d = deps({ changes: RISKY });
  for (let i = 0; i < 40; i++) d.ledger.charge("codex", 0);
  d.ledger.charge("deepseek", 300_000);
  const out = await runPipeline(d, { ...input, plan: "no" });
  const rev = out.trace.find((e) => e.role === "reviewer");
  assert.ok(rev && rev.backup === true && rev.key === "backup");
  assert.match(formatTrace(out.trace).join("\n"), /reviewer -> router9\/backup-free \[backup, fallback\]/);

  const d2 = deps({ changes: RISKY });
  for (let i = 0; i < 40; i++) d2.ledger.charge("codex", 0);
  d2.cfg = resolveConfig({});
  const out2 = await runPipeline(d2, { ...input, plan: "yes", research: ["q"] });
  assert.ok(out2.trace.filter((e) => e.key === "manager").every((e) => e.fellBack)); // planner/researcher fell back
  assert.ok(formatTrace(out2.trace).some((l) => /fallback/.test(l)));

  const d3 = deps();
  d3.spawn = async () => { throw new Error("boom: quota exceeded"); };
  const out3 = await runPipeline(d3, { ...input, plan: "no" });
  const errs = out3.trace.filter((e) => e.status === "error");
  assert.deepEqual(errs.map((e) => e.key), ["cursor", "backup"]); // both routes were tried
  assert.ok(formatTrace(out3.trace).some((l) => /FAILED\] .*\(boom: quota exceeded\)/.test(l)));
});
test("trace: Laya unavailable is recorded as such", async () => {
  const d = deps();
  d.laya = { noul: async () => null };
  const out = await runPipeline(d, input);
  assert.match(formatTrace(out.trace)[0], /laya needs_plan: unavailable/);
});

test("run log: one JSON line per call, never throws", () => {
  const f = join(tmp(), "sub", "runs.jsonl");
  assert.equal(recordRun(f, { a: 1 }), true);
  assert.equal(recordRun(f, { b: 2 }), true);
  assert.deepEqual(readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }]);
  assert.equal(recordRun("/dev/null/cannot/write.jsonl", { x: 1 }), false);
});

test("jev_run writes the run log with the trace, even when the run fails", async () => {
  const log = join(tmp(), "runs.jsonl");
  const cfg = resolveConfig({ runLog: log, laya: { enabled: false } });
  const ledger = new Ledger(join(tmp(), "l.json"), cfg.budgets);
  const ctx = {
    subagents: {
      resolveMaxDepth: () => 1,
      start: async () => ({ result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }), dispose() {} }),
    },
  };
  const tool = buildTool(ctx, cfg, ledger);
  const exec = { agent: { id: "h" }, signal: new AbortController().signal };
  // /nonexistent is not a repo: the diff step throws after the worker ran
  await assert.rejects(tool.execute({ task: "t", cwd: "/nonexistent/repo", plan: "no" }, exec));
  const [run] = readRuns(log, 1);
  assert.equal(run.status, "error");
  assert.ok(run.error);
  assert.equal(run.cwd, "/nonexistent/repo");
  assert.deepEqual(run.trace.map((e) => e.key), ["cursor"]);
  assert.ok(Date.parse(run.end) >= Date.parse(run.ts));
});

test("who.mjs: formats a run and refuses unsafe timestamps in the query", () => {
  const run = { ts: "2026-10-06T10:00:00.000Z", end: "2026-10-06T10:00:30.000Z", status: "done", cwd: "/r", task: "t",
    trace: [{ role: "laya", label: "needs_plan", status: "ok", detail: 0.2, ms: 50 }, { role: "worker", label: "worker-1", key: "cursor", provider: "router9", model: "cursor-workers", status: "ok", ms: 12300 }] };
  const text = formatRun(run);
  assert.match(text, /worker-1 -> router9\/cursor-workers \[cursor\] 12\.3s/);
  assert.match(text, /not called: planner, researcher, reviewer, final_reviewer/);
  assert.match(windowSql(run.ts, run.end), /timestamp >= '2026-10-06T09:59:55\.000Z' and timestamp <= '2026-10-06T10:00:35\.000Z'/);
  assert.throws(() => windowSql("x'; drop table usageHistory;--", run.end), /bad timestamp/);
});

test("who.mjs: finds the 9Router rows inside a run's window and nothing outside it", () => {
  const db = join(tmp(), "data.sqlite");
  const sql = (q) => execFileSync("sqlite3", [db, q]);
  sql("create table usageHistory (timestamp text, provider text, model text, promptTokens int, completionTokens int);");
  sql("insert into usageHistory values ('2026-10-06T10:00:10.000Z','cursor','default',1000,10),('2026-10-06T10:00:12.000Z','cursor','default',500,5),('2026-10-06T10:00:20.000Z','codex','gpt-6.1-sol',200,20),('2026-10-06T11:00:00.000Z','cursor','claude-4.6-opus-max',9999,9);");
  const rows = router9Window(db, { ts: "2026-10-06T10:00:00.000Z", end: "2026-10-06T10:00:30.000Z" });
  assert.deepEqual(rows.map((r) => `${r.provider}/${r.model}x${r.n}`), ["cursor/defaultx2", "codex/gpt-6.1-solx1"]);
  assert.ok(!rows.some((r) => r.model === "claude-4.6-opus-max"));
});

test("trace: a call cancelled mid-flight is recorded as cancelled, never as ok with nothing returned", async () => {
  const d = deps({ reply: "" });
  d.trace = [];
  let started = 0;
  d.spawn = async () => { started++; return ""; };
  d.aborted = () => started > 0; // the cancel arrives while the first worker is running
  await assert.rejects(runPipeline(d, { ...input, plan: "no" }), /run cancelled|no content/);
  const w = d.trace.find((e) => e.role === "worker");
  assert.ok(w, "the cancelled worker still leaves a trace entry");
  assert.equal(w.status, "cancelled");
  assert.match(w.error, /no content/);
  assert.match(formatTrace(d.trace).join("\n"), /\[cursor, CANCELLED\]|CANCELLED/);
});

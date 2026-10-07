// Assertions over one scenario's output. Usage: node check.mjs <A|B|C|D> <E2E_DIR>
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../../plugin/david-plugin/package.json", import.meta.url), "utf8")).version;
const [scen, dir] = process.argv.slice(2);
const out = readFileSync(`${dir}/head-${scen}.out`, "utf8");
const reqs = readFileSync(`${dir}/requests-${scen}.jsonl`, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
assert.ok(!reqs.some((r) => r.scriptError), `script error: ${JSON.stringify(reqs.find((r) => r.scriptError))}`);
const withTools = reqs.filter((r) => r.nTools > 0);
const toolsOf = (model) => withTools.filter((r) => r.model === model).map((r) => new Set(r.toolNames));
const ran = (model) => reqs.some((r) => r.model === model);
const SPAWNERS = ["david_run", "subagent", "subagent_fork", "workflow"];
const noSpawners = (model) => { for (const set of toolsOf(model)) for (const t of SPAWNERS) assert.ok(!set.has(t), `${model} was offered ${t}`); };
const readOnly = (model) => { for (const set of toolsOf(model)) for (const t of ["write", "edit"]) assert.ok(!set.has(t), `${model} (reviewer) was offered ${t}`); };
const ledger = () => JSON.parse(readFileSync(`${dir}/david-ledger.json`, "utf8")).used;

assert.ok(withTools.some((r) => r.toolNames.includes("david_run")), "david_run was never offered to the head agent: plugin not loaded");
assert.ok(out.includes(`Plugin: david plugin ${VERSION}`), `report has no "Plugin: david plugin ${VERSION}" footer`);
noSpawners("cursor-workers");
noSpawners("backup-free");

if (scen === "A") {
  assert.match(out, /david_run: done/);
  assert.match(out, /worker-1 -> router9\/cursor-workers \[cursor\]/);
  assert.equal(readFileSync(`${dir}/repo/hello.txt`, "utf8"), "hi");
  assert.match(out, /not called: planner, researcher, reviewer, final_reviewer/);
  for (const m of ["deepseek-v4.1-flash", "codex-head", "backup-free"]) assert.ok(!ran(m), `${m} ran for a trivial change`);
  assert.ok(!existsSync(`${dir}/david-ledger.json`), "ledger written although only free routes ran");
} else if (scen === "B") {
  assert.match(out, /david_run: done/);
  assert.ok(existsSync(`${dir}/repo/src/auth/login.js`));
  assert.match(out, /reviewer -> deepseek-host\/deepseek-v4\.1-flash \[deepseek\]/);
  assert.match(out, /final-reviewer -> router9\/codex-head \[codex\]/);
  assert.match(out, /Review triggers: risky path: src\/auth\/login\.js/);
  assert.ok(!ran("backup-free"), "backup ran although the primary reviewers were available");
  for (const m of ["deepseek-v4.1-flash", "codex-head"]) { assert.ok(toolsOf(m).length > 0, `${m} never ran`); noSpawners(m); readOnly(m); }
  const l = ledger();
  assert.ok(l.deepseek > 0 && l.codex === 1, `ledger wrong: ${JSON.stringify(l)}`);
} else if (scen === "E") {
  // five sub-tasks, cap of 3 on Cursor: all five finish, never more than 3 requests in flight, and it is still parallel
  assert.match(out, /david_run: done/);
  for (const f of ["f1", "f2", "f3", "f4", "f5"]) assert.equal(readFileSync(`${dir}/repo/${f}.txt`, "utf8"), "hi", `${f}.txt missing: a queued worker never ran`);
  assert.match(out, /worker-5 -> router9\/cursor-workers \[cursor\]/);
  const peak = Math.max(...reqs.filter((r) => r.model === "cursor-workers").map((r) => r.inflight));
  assert.ok(peak <= 3, `${peak} Cursor requests were in flight at once; the cap is 3`);
  assert.ok(peak >= 2, `peak ${peak}: the workers did not run in parallel at all`);
  console.log(`  (peak in-flight on cursor-workers: ${peak})`);
} else if (scen === "F") {
  // The filter names "bogus_tool_name", so the real Harness refuses it exactly as the desktop profile refused
  // "subagent". The worker must still start, finish, and the report must say the filter got weaker.
  assert.match(out, /david_run: done/);
  assert.equal(readFileSync(`${dir}/repo/hello.txt`, "utf8"), "hi");
  assert.ok(!/FAILED/.test(out), "a route failed instead of retrying without the refused name");
  assert.match(out, /worker-1 -> router9\/cursor-workers \[cursor\]/);
  assert.match(out, /child tool filter: this Harness does not let a filter name "bogus_tool_name"/);
} else if (scen === "C") {
  // Cursor answers HTTP 403 "quota exceeded": the worker must move to the backup route and finish.
  assert.match(out, /david_run: done/);
  assert.match(out, /worker-1 -> router9\/cursor-workers \[cursor, FAILED\]/);
  assert.match(out, /worker-1 -> router9\/backup-free \[backup, fallback\]/);
  assert.match(out, /worker ran on the BACKUP route \(router9\/backup-free\)/);
  assert.equal(readFileSync(`${dir}/repo/hello.txt`, "utf8"), "hi", "the backup worker did not make the change");
  for (const m of ["deepseek-v4.1-flash", "codex-head"]) assert.ok(!ran(m), `${m} ran for a trivial change`);
} else if (scen === "D") {
  // DeepSeek and Codex both answer 403: the reviewers run on the backup route. A risky diff approved only by
  // backup reviewers must stop for a person.
  assert.match(out, /david_run: awaiting_human/);
  assert.match(out, /reviewer -> deepseek-host\/deepseek-v4\.1-flash \[deepseek, FAILED\]/);
  assert.match(out, /reviewer -> router9\/codex-head \[codex, fallback, FAILED\]/);
  assert.match(out, /reviewer -> router9\/backup-free \[backup, fallback\]/);
  assert.match(out, /final-reviewer -> router9\/backup-free \[backup, fallback\]/);
  assert.match(out, /approved only by backup \(free\) reviewers: a person must sign off/);
  assert.ok(toolsOf("backup-free").length > 0, "backup never ran");
  noSpawners("backup-free");
  // backup-free also served the worker? no: the worker stayed on Cursor, so every backup request is a reviewer
  assert.ok(ran("cursor-workers"));
  for (const set of withTools.filter((r) => r.model === "backup-free" && r.firstUser.startsWith("ROLE: reviewer")).map((r) => new Set(r.toolNames))) {
    for (const t of ["write", "edit"]) assert.ok(!set.has(t), `backup reviewer was offered ${t}`);
  }
  assert.ok(ledger().deepseek > 0, "the failed DeepSeek attempt must still be charged");
  // cooldown: a route that just failed is not tried again by the final reviewer in the same run
  for (const m of ["deepseek-v4.1-flash", "codex-head"]) {
    assert.equal(reqs.filter((r) => r.model === m).length, 1, `${m} was called more than once: the failed route should be cooling down`);
  }
}
console.log(`scenario ${scen}: PASS`);

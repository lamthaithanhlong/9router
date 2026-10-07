import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/david-plugin/lib/config.js";
import { RouteHealth } from "../../plugin/david-plugin/lib/health.js";
import { formatReport, runPipeline } from "../../plugin/david-plugin/lib/pipeline.js";

const SMALL = { files: [{ path: "src/a.js", added: 5, removed: 1 }], diff: "diff --git a/src/a.js" };
const RISKY = { files: [{ path: "src/auth/login.js", added: 5, removed: 1 }], diff: "diff --git auth" };
const APPROVE = '{"verdict":"approve","issues":[]}';
const CHANGES = '{"verdict":"changes","issues":["login.js:4 skips the check"]}';
const CURSOR = "cursor-workers", CODEX = "codex-head", DS = "deepseek-v4.1-flash", BACKUP = "backup-free";

function harness(s = {}) {
  const calls = [];
  const prompts = [];
  const queues = new Map(Object.entries(s.replies ?? {}).map(([k, v]) => [k, [...v]]));
  const tests = [...(s.tests ?? [true])];
  const ledger = s.ledger ?? new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), DEFAULTS.budgets);
  const laya = { noul: async (id) => (s.laya && id in s.laya ? s.laya[id] : null) };
  const deps = {
    cfg: s.cfg ?? DEFAULTS,
    health: s.health,
    aborted: s.aborted,
    ledger,
    laya,
    log: () => {},
    loadPrompt: (role) => `ROLE: ${role}`,
    async spawn(route, prompt) {
      calls.push(route.model);
      prompts.push({ model: route.model, prompt });
      if (s.failModels?.includes(route.model)) throw new Error("quota exceeded");
      if (s.throwOn?.includes(route.model) && !s.thrown?.has(route.model)) {
        (s.thrown ??= new Set()).add(route.model);
        throw new Error("child crashed");
      }
      const q = queues.get(route.model) ?? [];
      return q.length > 1 ? q.shift() : (q[0] ?? "ok");
    },
    getChanges: async () => s.changes ?? SMALL,
    runTests: async () => ({ passed: tests.length > 1 ? tests.shift() : (tests[0] ?? true), summary: "1 failing", ran: true }),
  };
  return { deps, calls, prompts, ledger };
}

const input = (o = {}) => ({ task: "fix the bug", cwd: "/repo", tasks: ["fix the bug"], research: [], allowedPaths: ["src/**"], testCommand: "npm test", plan: "no", finalReview: false, ...o });

test("simple task: only Cursor runs, nothing paid is touched", async () => {
  const h = harness({ laya: { needs_review: 0.1 } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR]);
  assert.equal(h.ledger.used("deepseek"), 0);
  assert.equal(h.ledger.used("codex"), 0);
});

test("risky path: DeepSeek reviews, then Codex checks before merge", async () => {
  const h = harness({ changes: RISKY, laya: { needs_review: 0 }, replies: { [DS]: [APPROVE], [CODEX]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, DS, CODEX]);
  assert.ok(out.triggers.some((t) => t.startsWith("risky path")));
  assert.ok(h.ledger.used("deepseek") > 0);
  assert.equal(h.ledger.used("codex"), 1);
});

const REVIEW_ON = resolveConfig({ laya: { reviewEnabled: true } });

test("Laya can ADD a review that the rules did not ask for (when switched on)", async () => {
  const h = harness({ cfg: REVIEW_ON, laya: { needs_review: 0.8 }, replies: { [DS]: [APPROVE], [CODEX]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, DS, CODEX]);
  assert.ok(out.triggers.some((t) => t.startsWith("laya review risk 0.8")));
});

test("Laya can never REMOVE a review the rules asked for", async () => {
  const h = harness({ cfg: REVIEW_ON, changes: RISKY, laya: { needs_review: 0.0 }, replies: { [DS]: [APPROVE], [CODEX]: [APPROVE] } });
  await runPipeline(h.deps, input());
  assert.ok(h.calls.includes(DS));
});

test("by default Laya's review question is not even asked, so it cannot trigger a paid review", async () => {
  const h = harness({ laya: { needs_review: 0.99 } });
  h.deps.laya.noul = async (id) => { assert.notEqual(id, "needs_review", "must not ask"); return 0.99; };
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR]);
});

test("Vietnamese task: Laya is skipped for the plan question and length decides", async () => {
  const h = harness({});
  h.deps.laya.noul = async () => assert.fail("Laya must not be asked about a non-English task");
  const short = await runPipeline(h.deps, input({ plan: "auto", task: "đổi tên biến tmp thành total trong hàm nhỏ" }));
  assert.ok(short.notes.some((n) => /not English/.test(n)));
  assert.deepEqual(h.calls, [CURSOR]); // short: no plan
  const h2 = harness({ replies: { [CODEX]: ["PLAN"] } });
  h2.deps.laya.noul = async () => assert.fail("Laya must not be asked");
  await runPipeline(h2.deps, input({ plan: "auto", task: "x".repeat(10) + " việc dài ".repeat(60) }));
  assert.deepEqual(h2.calls, [CODEX, CURSOR]); // long: plan by Codex
});

test("planEnabled=false: Laya is never asked, length decides", async () => {
  const h = harness({ cfg: resolveConfig({ laya: { planEnabled: false } }) });
  h.deps.laya.noul = async () => assert.fail("Laya must not be asked when planEnabled is false");
  const out = await runPipeline(h.deps, input({ plan: "auto" }));
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR]);
});

test("Laya down: small diff still ships on the rules alone, and the note says why", async () => {
  const h = harness({ laya: {} });
  const out = await runPipeline(h.deps, input({ plan: "auto" }));
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR]);
  assert.ok(out.notes.some((n) => /laya unavailable/.test(n)));
});

test("plan: Laya yes sends the planner to Codex, and the plan prefixes every later prompt", async () => {
  const h = harness({ laya: { needs_plan: 0.9, needs_review: 0 }, replies: { [CODEX]: ["THE-PLAN"] } });
  const out = await runPipeline(h.deps, input({ plan: "auto" }));
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CODEX, CURSOR]);
  assert.ok(h.prompts[1].prompt.includes("# PLAN\nTHE-PLAN"));
});

test("plan: Laya says no, so no Codex call", async () => {
  const h = harness({ laya: { needs_plan: 0.1, needs_review: 0 } });
  await runPipeline(h.deps, input({ plan: "auto" }));
  assert.deepEqual(h.calls, [CURSOR]);
});

test("research goes to Codex and reaches the workers as a cut digest", async () => {
  const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
  const h = harness({ laya: { needs_review: 0 }, replies: { [CODEX]: [long] } });
  await runPipeline(h.deps, input({ research: ["how does X work upstream?"] }));
  assert.deepEqual(h.calls, [CODEX, CURSOR]);
  const worker = h.prompts[1].prompt;
  assert.match(worker, /# RESEARCH/);
  assert.match(worker, /\[digest cut\]/);
  assert.ok(!worker.includes("w350"));
});

test("research: with Codex quota spent the manager seat sends the researcher to DeepSeek", async () => {
  // The office rotates: Codex is out of calls, so DeepSeek-host holds it for this call. The worker
  // chain in DEFAULTS is still [cursor, backup], so the task itself runs on Cursor.
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), DEFAULTS.budgets);
  for (let i = 0; i < 40; i++) ledger.charge("codex", 0);
  const h = harness({ ledger, laya: { needs_review: 0 } });
  await runPipeline(h.deps, input({ research: ["q"] }));
  assert.deepEqual(h.calls, [DS, CURSOR]);
});

test("several tasks run as parallel workers; one crashing does not stop the rest", async () => {
  const h = harness({ laya: { needs_review: 0 }, throwOn: [CURSOR] });
  const out = await runPipeline(h.deps, input({ tasks: ["a", "b", "c"] }));
  assert.equal(out.status, "done");
  assert.equal(h.calls.filter((m) => m === CURSOR).length, 3);
});

test("every route of the worker chain fails: waits for a human, naming each attempt", async () => {
  const h = harness({ failModels: [CURSOR, BACKUP] });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "awaiting_human");
  assert.ok(out.notes.some((n) => /cursor: quota exceeded; backup: quota exceeded/.test(n)), JSON.stringify(out.notes));
  assert.deepEqual(h.calls, [CURSOR, BACKUP]);
});

test("Cursor out of quota: the worker falls back to the backup route and the report says so", async () => {
  const h = harness({ failModels: [CURSOR], laya: { needs_review: 0 } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, BACKUP]);
  const [bad, good] = out.trace.filter((e) => e.role === "worker");
  assert.equal(bad.status, "error");
  assert.match(bad.error, /quota exceeded/);
  assert.ok(good.backup === true && good.fellBack === true && good.status === "ok");
  assert.ok(out.notes.some((n) => /worker ran on the BACKUP route \(router9\/backup-free\)/.test(n)));
  assert.match(formatReport(out, SMALL), /\[backup, fallback\]/);
});

test("a failed route cools down: the next call goes straight to the backup, and the primary is retried after the cooldown", async () => {
  let t = 0;
  const health = new RouteHealth(1000, () => t);
  const h1 = harness({ failModels: [CURSOR], health, laya: { needs_review: 0 } });
  await runPipeline(h1.deps, input());
  assert.deepEqual(h1.calls, [CURSOR, BACKUP]);
  const h2 = harness({ failModels: [CURSOR], health, laya: { needs_review: 0 } });
  await runPipeline(h2.deps, input());
  assert.deepEqual(h2.calls, [BACKUP], "the cooling route must be skipped");
  t = 2000;
  const h3 = harness({ health, laya: { needs_review: 0 } }); // Cursor is healthy again
  await runPipeline(h3.deps, input());
  assert.deepEqual(h3.calls, [CURSOR]);
  assert.equal(health.cooling("cursor"), false); // a success clears it
});

test("a success clears the cooldown immediately, even while the cooldown window is still open", async () => {
  let t = 0;
  const health = new RouteHealth(10_000, () => t);
  health.fail("cursor");
  health.fail("backup"); // every worker route cooling: the plugin ignores the cooldown and tries in chain order
  t = 500;
  const h = harness({ health, laya: { needs_review: 0 } });
  await runPipeline(h.deps, input());
  assert.deepEqual(h.calls, [CURSOR]);
  assert.equal(health.cooling("cursor"), false, "a working route must not stay marked as failing");
  assert.equal(health.cooling("backup"), true);
});

test("cancelling the run is not a reason to try another route", async () => {
  const h = harness({ failModels: [CURSOR] });
  h.deps.aborted = () => h.calls.length > 0; // the cancel arrives while the first worker is running
  await assert.rejects(runPipeline(h.deps, input()), /run cancelled/);
  assert.deepEqual(h.calls, [CURSOR], "must not try the backup route after a cancel");
});
test("the reviewer sees plan and diff, never the worker's own words", async () => {
  const h = harness({ changes: RISKY, replies: { [CURSOR]: ["WORKER-REASONING-SECRET"], [DS]: [APPROVE], [CODEX]: [APPROVE] } });
  await runPipeline(h.deps, input());
  const reviews = h.prompts.filter((p) => p.model !== CURSOR);
  assert.ok(reviews.length >= 2);
  assert.ok(reviews.every((p) => !p.prompt.includes("WORKER-REASONING-SECRET")));
  assert.ok(reviews[0].prompt.includes("diff --git auth"));
});

test("reviewer asks for changes: fix round, second review, then done", async () => {
  const h = harness({ changes: RISKY, replies: { [DS]: [CHANGES, APPROVE], [CODEX]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, DS, CURSOR, DS, CODEX]);
});

test("reviewer never approves: stops for a human after the round limit, Codex untouched", async () => {
  const h = harness({ changes: RISKY, replies: { [DS]: [CHANGES] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "awaiting_human");
  assert.ok(!h.calls.includes(CODEX));
});

test("tests stay red: fails after the fix limit with no paid call", async () => {
  const h = harness({ tests: [false] });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "failed");
  assert.deepEqual(h.calls, [CURSOR, CURSOR, CURSOR]);
});

test("red twice then green: that alone triggers the paid review", async () => {
  const h = harness({ tests: [false, false, true], replies: { [DS]: [APPROVE], [CODEX]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.ok(out.triggers.some((t) => t.startsWith("tests red 2")));
  assert.ok(h.calls.includes(DS));
});

test("DeepSeek and Codex both spent: the review runs on the backup route, and a risky diff approved only by backup waits for a person", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), DEFAULTS.budgets);
  ledger.charge("deepseek", 300_000);
  for (let i = 0; i < 40; i++) ledger.charge("codex", 0);
  const h = harness({ ledger, changes: RISKY, replies: { [BACKUP]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "awaiting_human");
  assert.deepEqual(h.calls, [CURSOR, BACKUP, BACKUP]); // worker is on Cursor; both reviews on backup
  assert.ok(out.notes.some((n) => /approved only by backup \(free\) reviewers/.test(n)));
  assert.ok(!h.calls.includes(DS) && !h.calls.includes(CODEX));
});

test("backupPolicy.reviewIsFinal accepts a backup-only approval", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), DEFAULTS.budgets);
  ledger.charge("deepseek", 300_000);
  for (let i = 0; i < 40; i++) ledger.charge("codex", 0);
  const cfg = resolveConfig({ backupPolicy: { reviewIsFinal: true } });
  const h = harness({ cfg, ledger, changes: RISKY, replies: { [BACKUP]: [APPROVE] } });
  assert.equal((await runPipeline(h.deps, input())).status, "done");
});

test("the backup reviewer can still reject: that always stops for a person", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), DEFAULTS.budgets);
  ledger.charge("deepseek", 300_000);
  for (let i = 0; i < 40; i++) ledger.charge("codex", 0);
  const cfg = resolveConfig({ backupPolicy: { reviewIsFinal: true } });
  const h = harness({ cfg, ledger, changes: RISKY, replies: { [BACKUP]: [CHANGES] } });
  assert.equal((await runPipeline(h.deps, input())).status, "awaiting_human");
});
test("Codex spent but DeepSeek fine: gate 3 runs on the backup route, and DeepSeek's approval still counts", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), DEFAULTS.budgets);
  for (let i = 0; i < 40; i++) ledger.charge("codex", 0);
  const h = harness({ ledger, changes: RISKY, replies: { [DS]: [APPROVE], [BACKUP]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, DS, BACKUP]);
  assert.ok(out.notes.some((n) => /final_reviewer ran on the BACKUP route/.test(n)));
});
test("final reviewer objects: waits for a human instead of merging", async () => {
  const h = harness({ changes: RISKY, replies: { [DS]: [APPROVE], [CODEX]: [CHANGES] } });
  assert.equal((await runPipeline(h.deps, input())).status, "awaiting_human");
});

test("a reviewer that crashes falls to the next route and still charges its input tokens", async () => {
  const h = harness({ changes: RISKY, throwOn: [DS], replies: { [CODEX]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, DS, CODEX, CODEX]); // DeepSeek crashed -> Codex reviews, then final check
  assert.ok(h.ledger.used("deepseek") > 0, "the crashed attempt must still be charged");
});
test("no test command is called out, so green does not read as tested", async () => {
  const h = harness({ laya: { needs_review: 0 } });
  h.deps.runTests = async () => ({ passed: true, summary: "no test command given", ran: false });
  const out = await runPipeline(h.deps, input({ testCommand: "" }));
  assert.ok(out.notes.some((n) => /green means untested/.test(n)));
});

test("report: status first, human-needed line only when it applies", () => {
  const done = formatReport({ status: "done", notes: [], plan: "", triggers: [] }, SMALL);
  assert.match(done, /^jev_run: done/);
  assert.match(done, /src\/a\.js \(\+5 -1\)/);
  assert.ok(!/human decision/.test(done));
  assert.match(formatReport({ status: "awaiting_human", notes: ["x"], plan: "", triggers: [] }), /human decision/);
});

test("a route that answers with nothing counts as failed: the worker falls to the next route instead of 'succeeding' with empty text", async () => {
  const h = harness({ replies: { [CURSOR]: [""], [BACKUP]: ["did it"] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, BACKUP]);
  const failed = out.trace.find((e) => e.key === "cursor");
  assert.equal(failed.status, "error");
  assert.match(failed.error, /returned no content/);
});

test("whitespace-only text is empty too, for a reviewer: the next route on its chain reviews", async () => {
  const h = harness({ changes: RISKY, laya: { needs_review: 0 }, replies: { [DS]: ["  \n "], [CODEX]: [APPROVE] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "done");
  assert.deepEqual(h.calls, [CURSOR, DS, CODEX, CODEX]);
});

test("every route empty: the run does not pretend to have worked, a person decides", async () => {
  const h = harness({ replies: { [CURSOR]: [""], [BACKUP]: [""] } });
  const out = await runPipeline(h.deps, input());
  assert.equal(out.status, "awaiting_human");
  assert.ok(out.notes.some((n) => /no worker produced a result|returned no content|every route failed/.test(n)));
});

test("an empty answer cools the route down like any failure, so the next calls skip it", async () => {
  const health = new RouteHealth(60_000);
  const h = harness({ health, replies: { [CURSOR]: [""], [BACKUP]: ["ok"] } });
  await runPipeline(h.deps, input());
  assert.ok(health.cooling("cursor"));
  const h2 = harness({ health, replies: { [CURSOR]: ["would be fine"], [BACKUP]: ["ok"] } });
  await runPipeline(h2.deps, input());
  assert.deepEqual(h2.calls, [BACKUP], "the cooling Cursor route is not tried again");
});

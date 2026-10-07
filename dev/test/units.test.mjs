import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../plugin/jev-orchestrator/lib/budget.js";
import { capDiff, getChanges, parseNumstat, runTests } from "../../plugin/jev-orchestrator/lib/changes.js";
import { DEFAULTS, resolveConfig } from "../../plugin/jev-orchestrator/lib/config.js";
import { gate2Triggers, globToRegExp, parseVerdict } from "../../plugin/jev-orchestrator/lib/gates.js";
import { createLaya, looksEnglish } from "../../plugin/jev-orchestrator/lib/laya.js";
import { RouteHealth } from "../../plugin/jev-orchestrator/lib/health.js";
import { resolveRole } from "../../plugin/jev-orchestrator/lib/roles.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));
const ledgerAt = (day = "2026-10-06") => {
  let d = day;
  const file = join(tmp(), "ledger.json");
  return { file, ledger: new Ledger(file, DEFAULTS.budgets, () => d), setDay: (x) => (d = x) };
};
const spend = (ledger, key, n) => { for (let i = 0; i < n; i++) ledger.charge(key, 0); };

test("config: user values merge over defaults, arrays replace", () => {
  const c = resolveConfig({ budgets: { codex: { daily: 5 } }, gate2: { riskyPaths: ["x/**"] } });
  assert.equal(c.budgets.codex.daily, 5);
  assert.equal(c.budgets.codex.unit, "calls"); // untouched sibling kept
  assert.deepEqual(c.gate2.riskyPaths, ["x/**"]);
  assert.equal(DEFAULTS.budgets.codex.daily, 40); // defaults not mutated
});

test("glob: ** spans directories, * does not", () => {
  assert.ok(globToRegExp("**/auth/**").test("src/auth/login.js"));
  assert.ok(globToRegExp("**/auth/**").test("auth/login.js"));
  assert.ok(globToRegExp("src/*.js").test("src/a.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/deep/a.js"));
});

test("gate 2: small in-scope diff fires nothing; each rule fires on its own", () => {
  const g = DEFAULTS.gate2;
  assert.deepEqual(gate2Triggers({ files: [{ path: "src/u.js", added: 5, removed: 1 }], allowedPaths: ["src/**"], testFailStreak: 0 }, g), []);
  const t = gate2Triggers({
    files: [{ path: "src/auth/login.js", added: 100, removed: 60 }, { path: "docs/x.md", added: 1, removed: 0 }],
    allowedPaths: ["src/**"],
    testFailStreak: 2,
  }, g);
  assert.equal(t.length, 4);
  assert.deepEqual(gate2Triggers({ files: [{ path: "a.js", added: 1, removed: 0 }], allowedPaths: [], testFailStreak: 0 }, g), []);
});

test("verdict fails closed", () => {
  assert.equal(parseVerdict('{"verdict":"approve","issues":[]}').verdict, "approve");
  assert.equal(parseVerdict('```json\n{"verdict":"approve"}\n```').verdict, "approve");
  assert.equal(parseVerdict("looks good").verdict, "changes");
  assert.equal(parseVerdict('{"verdict":"maybe"}').verdict, "changes");
  assert.equal(parseVerdict("null").verdict, "changes");
});

test("ledger: persists, rolls over at midnight, free routes unmetered, Codex reserve", () => {
  const { ledger, file, setDay } = ledgerAt();
  ledger.charge("deepseek", 1000);
  assert.equal(new Ledger(file, DEFAULTS.budgets, () => "2026-10-06").used("deepseek"), 1000);
  setDay("2026-10-07");
  assert.equal(ledger.used("deepseek"), 0);
  ledger.charge("cursor", 9e9);
  assert.equal(ledger.remaining("cursor"), Infinity);

  const b = ledgerAt().ledger;
  spend(b, "codex", 32); // 8 of 40 left = the 20% reserve
  assert.ok(!b.canSpend("codex", 0, "researcher"));
  assert.ok(b.canSpend("codex", 0, "final_reviewer"));
});

test("roles: researcher falls back to the free manager route when Codex is spent", () => {
  const { ledger } = ledgerAt();
  spend(ledger, "codex", 40);
  const r = resolveRole("researcher", DEFAULTS, ledger, 100);
  assert.ok(r.kind === "route" && r.route.key === "manager" && r.fellBack);
  assert.equal(r.route.model, "manager-temp");
});

test("roles: with DeepSeek and Codex both spent the reviewer lands on the backup route; the worker stays on Cursor", () => {
  const { ledger } = ledgerAt();
  ledger.charge("deepseek", 300_000);
  spend(ledger, "codex", 40);
  const r = resolveRole("reviewer", DEFAULTS, ledger, 100);
  assert.ok(r.kind === "route" && r.route.key === "backup" && r.route.backup === true && r.fellBack);
  assert.equal(r.route.model, "backup-free");
  const w = resolveRole("worker", DEFAULTS, ledger, 100);
  assert.ok(w.kind === "route" && w.route.provider === "router9" && w.route.model === "cursor-workers");
});

test("roles: the backup route is the LAST entry of every chain (the owner's rule: free sources run only when the rest is out)", () => {
  for (const [role, chain] of Object.entries(DEFAULTS.chains)) {
    assert.equal(chain.at(-1), "backup", `${role} chain must end with backup`);
    assert.equal(chain.filter((k) => k === "backup").length, 1, `${role} must list backup once`);
  }
  assert.equal(DEFAULTS.routes.backup.cost, "free");
});

test("roles: routes that failed in this call are skipped; with everything skipped the role is held", () => {
  const { ledger } = ledgerAt();
  const r = resolveRole("worker", DEFAULTS, ledger, 100, { skip: ["cursor"] });
  assert.ok(r.kind === "route" && r.route.key === "backup");
  assert.equal(resolveRole("worker", DEFAULTS, ledger, 100, { skip: ["cursor", "backup"] }).kind, "hold");
});

test("roles: a cooling route is skipped, and when every route is cooling the cooldown is ignored", () => {
  const { ledger } = ledgerAt();
  let t = 0;
  const health = new RouteHealth(1000, () => t);
  health.fail("cursor");
  assert.equal(resolveRole("worker", DEFAULTS, ledger, 100, { health }).route.key, "backup");
  health.fail("backup");
  assert.equal(resolveRole("worker", DEFAULTS, ledger, 100, { health }).route.key, "cursor"); // all cooling: chain order again
  t = 5000;
  assert.equal(resolveRole("worker", DEFAULTS, ledger, 100, { health }).route.key, "cursor"); // cooldown over
});

test("health: fail starts a cooldown, ok clears it, it expires on its own", () => {
  let t = 0;
  const h = new RouteHealth(1000, () => t);
  assert.equal(h.cooling("x"), false);
  h.fail("x");
  assert.equal(h.cooling("x"), true);
  t = 999; assert.equal(h.cooling("x"), true);
  t = 1000; assert.equal(h.cooling("x"), false);
  h.fail("x"); h.ok("x");
  assert.equal(h.cooling("x"), false);
});
test("roles: a token budget refuses a call that would overshoot", () => {
  const { ledger } = ledgerAt();
  ledger.charge("deepseek", 299_000);
  const r = resolveRole("reviewer", DEFAULTS, ledger, 5_000);
  assert.ok(r.kind === "route" && r.route.key === "codex"); // DeepSeek refused, next on chain
});

test("laya client: returns the yes-probability, and null on every failure", async () => {
  const ok = createLaya(DEFAULTS.laya, { fetchImpl: async (url, init) => {
    assert.match(url, /\/v1\/systemone$/);
    const body = JSON.parse(init.body);
    assert.equal(body.questions.q.type, "noul");
    return { ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.73 } } }) };
  } });
  assert.equal(await ok.noul("q", "state", "instr"), 0.73);

  const down = createLaya(DEFAULTS.laya, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await down.noul("q", "s", "i"), null);
  const http = createLaya(DEFAULTS.laya, { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(await http.noul("q", "s", "i"), null);
  const odd = createLaya(DEFAULTS.laya, { fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { q: { type: "choice" } } }) }) });
  assert.equal(await odd.noul("q", "s", "i"), null);
  const off = createLaya({ ...DEFAULTS.laya, enabled: false }, { fetchImpl: async () => assert.fail("must not call") });
  assert.equal(await off.noul("q", "s", "i"), null);
});

test("looksEnglish: plain English yes, Vietnamese no, code-ish text yes", () => {
  assert.ok(looksEnglish("Rename the variable tmp to total in src/util.ts"));
  assert.ok(looksEnglish("fix: handle x === null (see #123)"));
  assert.ok(!looksEnglish("Việc: đổi tên biến tmp thành total trong một hàm nhỏ"));
  assert.ok(looksEnglish("12345 -> 67890"));
});

test("config: Laya review is off by default, plan is on", () => {
  assert.equal(DEFAULTS.laya.reviewEnabled, false);
  assert.equal(DEFAULTS.laya.planEnabled, true);
  assert.equal(DEFAULTS.laya.englishOnly, true);
});

test("laya client: starts laya-ctl in the background once per cooldown", async () => {
  const ctl = join(tmp(), "laya-ctl");
  writeFileSync(ctl, "#!/bin/sh\n");
  const started = [];
  let t = 0;
  const laya = createLaya({ ...DEFAULTS.laya, ctl, restartCooldownMs: 1000 }, {
    fetchImpl: async () => { throw new Error("down"); },
    spawnImpl: (cmd, args) => (started.push([cmd, ...args]), { unref() {} }),
    now: () => t,
  });
  await laya.noul("q", "s", "i");
  await laya.noul("q", "s", "i");
  assert.deepEqual(started, [[ctl, "start"]]);
  t = 2000;
  await laya.noul("q", "s", "i");
  assert.equal(started.length, 2);
});

test("numstat parsing and diff cap", () => {
  assert.deepEqual(parseNumstat("3\t1\tsrc/a.js\n-\t-\timg.png\n\n"), [
    { path: "src/a.js", added: 3, removed: 1 },
    { path: "img.png", added: 0, removed: 0 },
  ]);
  assert.match(capDiff("x".repeat(100), 10), /diff truncated: 90/);
  assert.equal(capDiff("short", 10), "short");
});

test("getChanges: sees tracked edits and new files, and leaves the index alone", async () => {
  const dir = tmp();
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.js"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "src/a.js"), "one\nTWO\nthree\n");
  writeFileSync(join(dir, "src/new.js"), "a\nb\n");
  const c = await getChanges(dir, 60_000);
  assert.deepEqual(c.files.map((f) => f.path).sort(), ["src/a.js", "src/new.js"]);
  assert.ok(c.diff.includes("+three") && c.diff.includes("--- new file: src/new.js"));
  assert.equal(git("status", "--porcelain").includes("?? src/new.js"), true); // still untracked: index untouched
});

test("runTests: exit code decides; no command means untested", async () => {
  const dir = tmp();
  assert.deepEqual(await runTests(dir, "", 5000), { passed: true, summary: "no test command given", ran: false });
  assert.equal((await runTests(dir, "true", 5000)).passed, true);
  const bad = await runTests(dir, "echo broken >&2; exit 3", 5000);
  assert.ok(!bad.passed && bad.ran && /broken/.test(bad.summary));
});

import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { buildTool } from "../../plugin/david-plugin/index.js";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/david-plugin/lib/config.js";
import { createQueue, idSource, taskId } from "../../plugin/david-plugin/lib/queue.js";

// A queue bug usually shows up as waiting forever, so every test here has a deadline and fails instead of hanging.
const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn);
const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { waitMs: 150, claimedWaitMs: 1000, pollMs: 10, settleMs: 0 };
const ls = (dir, sub) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : []);
const visible = (dir, sub) => ls(dir, sub).filter((n) => !n.startsWith("."));
const ask = (q, o = {}) => q.submit({ id: "t1", label: "worker-1", role: "worker", cwd: "/repo", prompt: "change the thing", ...o });

// The person's side of the protocol: claim the oldest pending task, then write the result.
async function app(dir, { claimAfter = 0, doneAfter = 0, text = "## Summary\ndone it\n\n## Files changed\na.js\n\n## Not done\nnothing" } = {}) {
  for (let i = 0; i < 400; i++) {
    const [name] = visible(dir, "pending").sort();
    if (name) {
      await wait(claimAfter);
      renameSync(join(dir, "pending", name), join(dir, "claimed", name));
      await wait(doneAfter);
      writeFileSync(join(dir, "done", name), text);
      return name;
    }
    await wait(5);
  }
  throw new Error("app saw no task");
}

test("a task is written whole, the app claims it and writes a result, and the plugin returns that result and archives both files", async () => {
  const dir = tmp();
  const q = createQueue({ dir, ...FAST });
  let seen;
  const peek = (async () => { // look at the task while it is pending
    for (let i = 0; i < 200 && !visible(dir, "pending").length; i++) await wait(5);
    seen = readFileSync(join(dir, "pending", visible(dir, "pending")[0]), "utf8");
  })();
  const [text] = await Promise.all([ask(q), app(dir, { claimAfter: 40, doneAfter: 20 }), peek]);
  assert.match(text, /## Summary\ndone it/);
  assert.match(seen, /^---\nid: t1\nlabel: worker-1\nrole: worker\ncwd: \/repo\n/);
  assert.match(seen, /change the thing/);
  assert.match(seen, /done\/t1\.md/, "the task itself says where the result goes");
  assert.ok(existsSync(join(dir, "README.md")));
  assert.deepEqual(ls(dir, "pending"), [], "no task and no temp file left in pending");
  assert.deepEqual(ls(dir, "claimed"), []);
  assert.deepEqual(ls(dir, "done"), []);
  assert.deepEqual(ls(dir, "archive").sort(), ["t1.result.md", "t1.task.md"]);
});

test("nobody picks the task up: it is withdrawn into expired/ and the call fails, so the run can fall back", async () => {
  const dir = tmp();
  const q = createQueue({ dir, ...FAST, waitMs: 80 });
  await assert.rejects(ask(q), /nobody picked t1 up within .*withdrawn/);
  assert.deepEqual(ls(dir, "pending"), []);
  assert.deepEqual(ls(dir, "expired"), ["t1.md"]);
});

test("a task claimed in time keeps waiting past waitMs: the pickup timer stops once the app has it", async () => {
  const dir = tmp();
  const q = createQueue({ dir, ...FAST, waitMs: 60 });
  const [text] = await Promise.all([ask(q), app(dir, { claimAfter: 20, doneAfter: 300 })]);
  assert.match(text, /done it/);
  assert.deepEqual(ls(dir, "expired"), []);
});

test("claimed but never finished: it fails after claimedWaitMs and the file moves to expired/", async () => {
  const dir = tmp();
  const q = createQueue({ dir, ...FAST, claimedWaitMs: 100 });
  const claim = (async () => {
    for (let i = 0; i < 200 && !visible(dir, "pending").length; i++) await wait(5);
    const n = visible(dir, "pending")[0];
    renameSync(join(dir, "pending", n), join(dir, "claimed", n));
  })();
  await assert.rejects(Promise.all([ask(q), claim]), /claimed but not finished within/);
  assert.deepEqual(ls(dir, "expired"), ["t1.md"]);
});

test("cancelling the run withdraws a task that is still pending", async () => {
  const dir = tmp();
  const q = createQueue({ dir, ...FAST, waitMs: 5000 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  await assert.rejects(ask(q, { signal: ac.signal }), /withdrawn because the run was cancelled/);
  assert.deepEqual(ls(dir, "pending"), []);
  assert.deepEqual(ls(dir, "expired"), ["t1.md"]);
});

test("a task file that vanishes is reported, not waited on forever", async () => {
  const dir = tmp();
  const q = createQueue({ dir, ...FAST, waitMs: 5000 });
  setTimeout(() => rmSync(join(dir, "pending", "t1.md")), 30);
  await assert.rejects(ask(q), /disappeared from the queue folder/);
});

test("a result that is still being written is not read until it has stopped changing", async () => {
  const dir = tmp();
  const q = createQueue({ dir, ...FAST, settleMs: 200 });
  let wroteAt = 0;
  const writer = (async () => {
    for (let i = 0; i < 200 && !visible(dir, "pending").length; i++) await wait(5);
    const n = visible(dir, "pending")[0];
    renameSync(join(dir, "pending", n), join(dir, "claimed", n));
    wroteAt = Date.now();
    writeFileSync(join(dir, "done", n), "half");
    await wait(80);
    writeFileSync(join(dir, "done", n), "the whole result");
  })();
  const [text] = await Promise.all([ask(q), writer]);
  assert.equal(text, "the whole result", "the half-written first version must not be returned");
  assert.ok(Date.now() - wroteAt >= 200);
});

test("task ids are unique per call and safe as file names", () => {
  assert.notEqual(taskId("k1", 1, "worker-1"), taskId("k1", 2, "worker-1"));
  assert.notEqual(taskId("k1", 1, "worker-fix"), taskId("k1", 2, "worker-fix"), "a fix round reuses the label and must not collide");
  assert.match(taskId("k1", 3, "Worker 1 / ../../etc"), /^[a-z0-9-]+$/);
});

test("one run, one id source: two tasks with the same label (a fix round) still get different ids", () => {
  const next = idSource("k1");
  const a = next("worker-fix"), b = next("worker-fix");
  assert.notEqual(a, b);
  assert.notEqual(idSource("k1")("worker-fix"), idSource("k2")("worker-fix"), "and two runs do not share ids");
});

test("defaults: the queue route exists but is on no chain, so nothing waits for a person unless the config says so", () => {
  assert.equal(DEFAULTS.routes.cursorqueue.kind, "queue");
  for (const [role, chain] of Object.entries(DEFAULTS.chains)) assert.ok(!chain.includes("cursorqueue"), `${role} must not wait on a person by default`);
  assert.ok(DEFAULTS.limits.concurrency.cursorqueue >= 1);
  const on = resolveConfig({ chains: { worker: ["cursorqueue", "backup"] } });
  assert.deepEqual(on.chains.worker, ["cursorqueue", "backup"]);
  assert.deepEqual(on.chains.planner, DEFAULTS.chains.planner, "other roles are untouched");
});

// ---- through jev_run: the worker goes to the queue, no Harness child is started for it ----
function ctxWithStarts() {
  const starts = [];
  return {
    starts,
    subagents: {
      resolveMaxDepth: () => 1,
      start: async (_p, req) => (starts.push(req), { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }), dispose() {} }),
    },
  };
}
const toolFor = (ctx, dir, extra = {}) => {
  const cfg = resolveConfig({ laya: { enabled: false }, runLog: join(tmp(), "r.jsonl"), chains: { worker: ["cursorqueue", "backup"] }, cursorQueue: { dir, ...FAST }, ...extra });
  return buildTool(ctx, cfg, new Ledger(join(tmp(), "l.json"), cfg.budgets));
};
const run = (tool) => tool.execute({ task: "t", cwd: "/definitely/not/a/repo", plan: "no" }, { agent: {}, signal: new AbortController().signal }).catch((e) => e);

test("jev_run with the queue first: a picked-up task starts no worker child", async () => {
  const dir = tmp();
  const ctx = ctxWithStarts();
  const tool = toolFor(ctx, dir);
  await Promise.all([run(tool), app(dir, { claimAfter: 10, doneAfter: 10 })]);
  assert.equal(ctx.starts.length, 0, "the app did the work, so the Harness must not start a worker child");
  assert.equal(ls(dir, "archive").length, 2);
  const task = readFileSync(join(dir, "archive", ls(dir, "archive").find((n) => n.endsWith(".task.md"))), "utf8");
  assert.match(task, /ROLE: worker/, "the worker prompt reaches the app");
  assert.match(task, /cwd: \/definitely\/not\/a\/repo/);
});

test("jev_run with the queue first: an unclaimed task falls to the backup route and the task is withdrawn", async () => {
  const dir = tmp();
  const ctx = ctxWithStarts();
  const tool = toolFor(ctx, dir, { cursorQueue: { dir, ...FAST, waitMs: 60 } });
  await run(tool);
  assert.equal(ctx.starts.length, 1);
  assert.equal(ctx.starts[0].agentOptions.model, "backup-free", "the backup took the work");
  assert.equal(ls(dir, "expired").length, 1, "and the task is no longer waiting for the app");
  assert.deepEqual(ls(dir, "pending"), []);
});

test("jev_run with two sub-tasks: each gets its own task file, so neither overwrites the other", async () => {
  const dir = tmp();
  const ctx = ctxWithStarts();
  const tool = toolFor(ctx, dir);
  const both = tool.execute({ task: "t", tasks: ["part one", "part two"], cwd: "/definitely/not/a/repo", plan: "no" }, { agent: {}, signal: new AbortController().signal }).catch((e) => e);
  const seen = [];
  const person = (async () => { seen.push(await app(dir)); seen.push(await app(dir)); })();
  await Promise.all([both, person]);
  assert.equal(new Set(seen).size, 2, "two different task files were handed out");
  assert.equal(ls(dir, "archive").filter((n) => n.endsWith(".result.md")).length, 2);
  assert.equal(ctx.starts.length, 0);
});

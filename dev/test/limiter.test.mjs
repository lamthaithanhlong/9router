import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTool, newLimiter } from "../../plugin/jev-orchestrator/index.js";
import { Ledger } from "../../plugin/jev-orchestrator/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/jev-orchestrator/lib/config.js";
import { Limiter } from "../../plugin/jev-orchestrator/lib/limiter.js";
import { formatTrace, runPipeline } from "../../plugin/jev-orchestrator/lib/pipeline.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));
const tick = () => new Promise((r) => setImmediate(r));

test("defaults: Cursor is capped at 3 children and starts are spaced out; cursor-workers and manager-temp share the cap", () => {
  assert.equal(DEFAULTS.limits.concurrency.cursor, 3);
  assert.ok(DEFAULTS.limits.startGapMs.cursor >= 1000);
  assert.equal(DEFAULTS.routes.cursor.group, "cursor");
  assert.equal(DEFAULTS.routes.manager.group, "cursor", "manager-temp is Cursor too and must count against the same cap");
  assert.notEqual(DEFAULTS.routes.backup.group, "cursor");
});

test("limiter: never more than the cap run at once, the rest wait in order, and a release lets the next in", async () => {
  const lim = new Limiter({ limits: { g: 2 } });
  const order = [];
  const r1 = await lim.acquire("g");
  const r2 = await lim.acquire("g");
  const p3 = lim.acquire("g").then((r) => (order.push(3), r));
  const p4 = lim.acquire("g").then((r) => (order.push(4), r));
  await tick();
  assert.equal(lim.active("g"), 2);
  assert.deepEqual(order, [], "third and fourth must wait");
  r1();
  const r3 = await p3;
  assert.deepEqual(order, [3]);
  assert.equal(lim.active("g"), 2);
  r2(); r3();
  const r4 = await p4;
  assert.deepEqual(order, [3, 4], "first come, first served");
  r4(); r4(); // a double release must not free two slots
  assert.equal(lim.active("g"), 0);
});

test("limiter: a group without a limit is never held, and groups do not affect each other", async () => {
  const lim = new Limiter({ limits: { a: 1 } });
  const ra = await lim.acquire("a");
  for (let i = 0; i < 5; i++) await lim.acquire("free"); // unlimited
  const rb = await Promise.race([lim.acquire("b"), tick().then(() => "blocked")]);
  assert.notEqual(rb, "blocked");
  ra();
});

test("limiter: starts in a group are at least one gap apart, even when requested together", async () => {
  // virtual time: sleeping parks the caller until the test moves the clock to its wake-up time
  let t = 1000;
  const parked = [];
  const sleep = (ms) => new Promise((resolve) => parked.push({ at: t + ms, resolve }));
  const lim = new Limiter({ gaps: { g: 500 }, now: () => t, sleep });
  const startedAt = [];
  const all = Promise.all([1, 2, 3].map(async () => { const r = await lim.acquire("g"); startedAt.push(t); r(); }));
  while (startedAt.length < 3) {
    await tick();
    if (parked.length === 0) continue;
    parked.sort((a, b) => a.at - b.at);
    const next = parked.shift();
    t = next.at;
    next.resolve();
  }
  await all;
  assert.deepEqual(startedAt, [1000, 1500, 2000], "first starts at once, the next two 500 ms apart");
});

test("limiter: queued time is reported on the release function", async () => {
  let t = 0;
  const lim = new Limiter({ limits: { g: 1 }, now: () => t });
  const r1 = await lim.acquire("g");
  const p2 = lim.acquire("g");
  t = 4200;
  r1();
  const r2 = await p2;
  assert.equal(r2.queuedMs, 4200);
});

function harness(over = {}) {
  const calls = [];
  const state = { active: 0, max: 0 };
  const cfg = over.cfg ?? DEFAULTS;
  return {
    state, calls,
    deps: {
      cfg,
      ledger: new Ledger(join(tmp(), "l.json"), cfg.budgets),
      laya: { noul: async () => null },
      log: () => {},
      limiter: over.limiter,
      loadPrompt: (r) => `ROLE: ${r}`,
      async spawn(route) {
        calls.push(route.model);
        state.active++;
        state.max = Math.max(state.max, state.active);
        await tick(); await tick(); // hold the slot long enough for others to pile up
        state.active--;
        return "ok";
      },
      getChanges: async () => ({ files: [{ path: "a.js", added: 1, removed: 0 }], diff: "d" }),
      runTests: async () => ({ passed: true, summary: "", ran: true }),
    },
  };
}
const input = (o = {}) => ({ task: "t", cwd: "/r", tasks: ["a"], research: [], allowedPaths: [], testCommand: "x", plan: "no", finalReview: false, ...o });

test("pipeline: six sub-tasks run at most three at a time, and all six finish", async () => {
  const h = harness({ limiter: new Limiter({ limits: { cursor: 3 } }) });
  const out = await runPipeline(h.deps, input({ tasks: ["1", "2", "3", "4", "5", "6"] }));
  assert.equal(out.status, "done");
  assert.equal(h.calls.filter((m) => m === "cursor-workers").length, 6);
  assert.equal(h.state.max, 3, "three in parallel, no more");
});

test("pipeline: without a limiter all six start at once (documents what the cap prevents)", async () => {
  const h = harness();
  await runPipeline(h.deps, input({ tasks: ["1", "2", "3", "4", "5", "6"] }));
  assert.equal(h.state.max, 6);
});

test("pipeline: two runs at the same time share one cap", async () => {
  const limiter = new Limiter({ limits: { cursor: 3 } });
  const h1 = harness({ limiter });
  const h2 = harness({ limiter });
  const shared = { active: 0, max: 0 };
  for (const h of [h1, h2]) {
    const orig = h.deps.spawn;
    h.deps.spawn = async (route) => { shared.active++; shared.max = Math.max(shared.max, shared.active); try { return await orig(route); } finally { shared.active--; } };
  }
  await Promise.all([runPipeline(h1.deps, input({ tasks: ["1", "2", "3"] })), runPipeline(h2.deps, input({ tasks: ["1", "2", "3"] }))]);
  assert.ok(shared.max <= 3, `6 workers across two runs peaked at ${shared.max}`);
  assert.ok(shared.max >= 2, "still parallel");
});

test("pipeline: a failing child still frees its slot", async () => {
  const limiter = new Limiter({ limits: { cursor: 1 } });
  const h = harness({ limiter });
  let n = 0;
  const orig = h.deps.spawn;
  h.deps.spawn = async (route) => { if (route.key === "cursor" && n++ === 0) throw new Error("rate limited"); return orig(route); };
  const out = await runPipeline(h.deps, input({ tasks: ["1", "2"] }));
  assert.equal(out.status, "done");
  assert.equal(limiter.active("cursor"), 0, "no leaked slot");
});

test("pipeline: time spent queued is shown in the report", async () => {
  let t = 0;
  const limiter = new Limiter({ limits: { cursor: 1 }, now: () => t });
  const h = harness({ limiter });
  const orig = h.deps.spawn;
  h.deps.spawn = async (route) => { const r = await orig(route); t += 3000; return r; };
  const out = await runPipeline(h.deps, input({ tasks: ["1", "2"] }));
  assert.ok(out.trace.some((e) => e.queuedMs >= 3000));
  assert.match(formatTrace(out.trace).join("\n"), /\(queued 3\.0s\)/);
});

function toolCtx() {
  const starts = [];
  return {
    starts,
    subagents: { resolveMaxDepth: () => 1, start: async (_p, req) => (starts.push(req), { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }), dispose() {} }) },
  };
}
const execOf = () => ({ agent: {}, signal: new AbortController().signal });
const toolFor = (ctx) => {
  const cfg = resolveConfig({ laya: { enabled: false }, runLog: join(tmp(), "r.jsonl") });
  return buildTool(ctx, cfg, new Ledger(join(tmp(), "l.json"), cfg.budgets), () => {}, undefined, newLimiter(cfg));
};

test("jev_run refuses more sub-tasks or research questions than the limit, before starting anything", async () => {
  const ctx = toolCtx();
  const tool = toolFor(ctx);
  const seven = Array.from({ length: 7 }, (_, i) => `t${i}`);
  await assert.rejects(tool.execute({ task: "t", cwd: "/x", tasks: seven }, execOf()), /refused: 7 sub-tasks is more than the limit of 6/);
  await assert.rejects(tool.execute({ task: "t", cwd: "/x", research: ["a", "b", "c", "d"] }, execOf()), /refused: 4 research questions/);
  assert.equal(ctx.starts.length, 0, "nothing may start when the call is refused");
});

test("jev_run accepts the limit itself and tells the model about the cap", async () => {
  const ctx = toolCtx();
  const tool = toolFor(ctx);
  assert.match(tool.parameters.properties.tasks.description, /At most 3 workers run at the same time/);
  await tool.execute({ task: "t", cwd: "/definitely/not/a/repo", tasks: ["1", "2", "3", "4", "5", "6"], plan: "no" }, execOf()).catch(() => {});
  assert.equal(ctx.starts.length, 6);
});

test("pipeline: manager-temp children count against the Cursor cap too (same upstream, different route)", async () => {
  // Codex out of calls: the researchers fall back to manager-temp, which is Cursor
  const h = harness({ limiter: new Limiter({ limits: { cursor: 2 } }) });
  for (let i = 0; i < 40; i++) h.deps.ledger.charge("codex", 0);
  await runPipeline(h.deps, input({ research: ["a", "b", "c"] }));
  assert.equal(h.calls.filter((m) => m === "manager-temp").length, 3);
  assert.equal(h.state.max, 2, "three Cursor researchers must still respect the cap of 2");
});

test("one tool instance shares one cap across two simultaneous jev_run calls", async () => {
  let active = 0, peak = 0;
  const ctx = {
    subagents: {
      resolveMaxDepth: () => 1,
      async start() {
        active++; peak = Math.max(peak, active);
        return { result: (async () => { await tick(); await tick(); active--; return { stopReason: "completed", output: [{ type: "text", text: "ok" }] }; })(), dispose() {} };
      },
    },
  };
  const cfg = resolveConfig({ laya: { enabled: false }, runLog: join(tmp(), "r.jsonl"), limits: { startGapMs: { cursor: 0 } } });
  const tool = buildTool(ctx, cfg, new Ledger(join(tmp(), "l.json"), cfg.budgets), () => {}, undefined, newLimiter(cfg));
  const call = () => tool.execute({ task: "t", cwd: "/definitely/not/a/repo", tasks: ["1", "2", "3"], plan: "no" }, execOf()).catch(() => {});
  await Promise.all([call(), call()]);
  assert.ok(peak <= 3, `peaked at ${peak} children`);
  assert.ok(peak >= 2);
});

import { SANDBOX_HOME } from "./_sandbox.mjs";
// The live dashboard: what it derives from the step feed, and that the HTTP surface answers and
// stops cleanly. It reads files only - a test that made it call a model would be a bug in the test.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDashboard, currentRun, stagesOf } from "../../plugin/jev-orchestrator/lib/dashboard.js";

const T = "2026-10-07T17:29:23.000Z";
const step = (o) => JSON.stringify({ ts: T, run: "abc", text: "", ...o });

test("stagesOf: a child's own words cannot move a stage, and a cancelled call is failed", () => {
  const steps = [
    { ts: T, run: "abc", text: "worker-1 started on deepseek", role: "worker", label: "worker-1", route: "deepseek" },
    // model text that happens to contain the pipeline's own phrases:
    { ts: T, run: "abc", text: "grep: tests done in 2s, started on main", role: "worker", label: "worker-1", route: "deepseek", child: true, kind: "kết" },
    { ts: T, run: "abc", text: "worker-2 started on cursor", role: "worker", label: "worker-2", route: "cursor" },
    { ts: T, run: "abc", text: "worker-2 cancelled after 30.2s, $0.0000 (worker-2 ended with aborted)", role: "worker", label: "worker-2", route: "cursor", status: "error" },
  ];
  const [w1, w2] = stagesOf(steps, "abc");
  assert.equal(w1.status, "running", "a child line saying 'done in' must not finish the card");
  assert.equal(w1.text, "grep: tests done in 2s, started on main", "but the card still shows the latest thing it did");
  assert.equal(w2.status, "failed");
});

test("stagesOf: groups the feed by label and derives running / done / failed", () => {
  const steps = [
    { ts: T, run: "abc", text: "planner started on codex (via manager)", role: "planner", label: "planner", route: "codex", model: "codex-head", via: "manager", turn: 1 },
    { ts: T, run: "abc", text: "planner done in 60.5s, $0.1079 (5 upstream attempts)", role: "planner", label: "planner", route: "codex", usd: 0.1079 },
    { ts: T, run: "abc", text: "worker-1 started on cursor", role: "worker", label: "worker-1", route: "cursor", model: "cursor-workers" },
    { ts: T, run: "abc", text: "worker-1 failed in 290.1s, $0.0000", role: "worker", label: "worker-1", route: "cursor", usd: 0, status: "error" },
    { ts: T, run: "old", text: "planner started on codex", role: "planner", label: "planner", route: "codex" },
  ];
  const stages = stagesOf(steps, "abc");
  assert.deepEqual(stages.map((s) => s.label), ["planner", "worker-1"], "only this run, in first-seen order");
  const [planner, worker] = stages;
  assert.equal(planner.status, "done");
  assert.equal(planner.via, "manager");
  assert.equal(planner.turn, 1);
  assert.ok(Math.abs(planner.usd - 0.1079) < 1e-9);
  assert.equal(worker.status, "failed");
  assert.equal(worker.route, "cursor");
});

test("stagesOf: a started line with no finish line is still running", () => {
  const stages = stagesOf([{ ts: T, run: "abc", text: "worker-1 started on deepseek", role: "worker", label: "worker-1", route: "deepseek" }], "abc");
  assert.equal(stages[0].status, "running");
  assert.equal(stages[0].endedAt, null);
});

test("currentRun: a run that was cancelled is not shown as running forever", () => {
  const T0 = "2026-10-07T19:27:22.633Z";
  const body = [{ ts: T0, run: "x", text: "run started" }, { ts: T0, run: "x", text: "worker-1 started on deepseek", role: "worker", label: "worker-1" }];
  // new runs write a closing line
  const ended = currentRun([...body, { ts: "2026-10-07T19:27:52.830Z", run: "x", text: "run ended: run cancelled", status: "error" }], []);
  assert.equal(ended.status, "error");
  assert.ok(ended.endedAt);
  // old runs have none: the run log (written in a finally) closes them
  const legacy = currentRun(body, [{ ts: T0, end: "2026-10-07T19:27:52.830Z", status: "error", task: "t", cwd: "/r" }]);
  assert.equal(legacy.status, "error");
  assert.equal(legacy.endedAt, "2026-10-07T19:27:52.830Z");
  // a genuinely live run (no log entry yet) is still running
  assert.equal(currentRun(body, [{ ts: "2026-10-07T18:00:00.000Z", end: "2026-10-07T18:05:00.000Z", status: "done" }]).status, "running");
});

test("currentRun: finds the live run, and closes it on the run-done line", () => {
  const S = (o) => ({ ts: T, run: "abc", text: "", ...o });
  const open = [S({ text: "run started" }), S({ text: "planner started on codex" })];
  const r1 = currentRun(open, []);
  assert.equal(r1.id, "abc");
  assert.equal(r1.status, "running");
  assert.equal(r1.endedAt, null);

  const closed = [...open, S({ text: "run done: $0.0042, 3 calls", usd: 0.0042, status: "awaiting_human" })];
  const r2 = currentRun(closed, [{ ts: "2026-10-07T17:29:20.000Z", end: "2026-10-07T17:36:05.000Z", status: "awaiting_human", task: "x", cwd: "/repo" }]);
  assert.equal(r2.status, "awaiting_human", "the run log's verdict wins over the default");
  assert.equal(r2.cwd, "/repo");
  assert.equal(r2.usd, 0.0042);

  assert.equal(currentRun([], []), null, "an empty feed is not a run");
});

// Wait for the listener without guessing: the OS picks the port and we poll the handle.
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the dashboard");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("dashboard: /state and / answer, /events opens an SSE frame, and it stops cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-dash-"));
  const stepsFile = join(dir, "steps.jsonl");
  writeFileSync(stepsFile, [
    step({ text: "run started" }),
    step({ text: "planner started on codex (via manager)", role: "planner", label: "planner", route: "codex", model: "codex-head", via: "manager", turn: 1 }),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "runs.jsonl"), "");
  const pageFile = join(dir, "index.html");
  writeFileSync(pageFile, "<html>ok</html>");

  const cfg = {
    stepsFile, runLog: join(dir, "runs.jsonl"), ledgerFile: join(dir, "ledger.json"),
    budgets: { codex: { unit: "calls", daily: 40 } },
    routes: { codex: { provider: "router9", model: "codex-head" } },
    cost: { dbFile: join(dir, "no-such-9router.sqlite") },
  };
  const ledger = { load: () => ({ day: "2026-10-07", used: { codex: 5 } }) };
  const dash = createDashboard({ cfg, ledger, version: "0.0.0-test", port: 0, pageFile, log: () => {} });
  try {
    const base = await until(() => dash.url());
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, "loopback only");

    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.version, "0.0.0-test");
    assert.equal(state.run.id, "abc");
    assert.equal(state.run.stages.find((s) => s.label === "planner").via, "manager", "the office is named");
    assert.equal(state.cfo.wallet, "OK");
    assert.deepEqual(state.cfo.perRoute.map((r) => r.key), ["codex"], "only routes with a budget entry");
    assert.equal(state.cfo.perRoute[0].used, 5);
    assert.equal(state.sources.steps, 2);
    assert.equal(state.sources.nineRouter, false, "no 9Router DB here, and that must not throw");

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal((await page.text()).trim(), "<html>ok</html>");

    const sse = await fetch(`${base}/events`);
    assert.match(sse.headers.get("content-type"), /text\/event-stream/);
    const reader = sse.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: snapshot/, "the first frame is a snapshot");
    await reader.cancel();

    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    dash.close();
  }
});

test("dashboard: a step appended while a page is connected also refreshes the snapshot (cards and FLOW follow the run)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-dash-live-"));
  const stepsFile = join(dir, "steps.jsonl");
  writeFileSync(stepsFile, [step({ text: "run started" }), step({ text: "worker-1 started on deepseek", role: "worker", label: "worker-1", route: "deepseek" })].join("\n") + "\n");
  writeFileSync(join(dir, "runs.jsonl"), "");
  const pageFile = join(dir, "index.html");
  writeFileSync(pageFile, "<html></html>");
  const cfg = { stepsFile, runLog: join(dir, "runs.jsonl"), ledgerFile: join(dir, "l.json"), budgets: {}, routes: {}, cost: { dbFile: join(dir, "none.sqlite") } };
  const dash = createDashboard({ cfg, ledger: { load: () => ({ day: "d", used: {} }) }, version: "t", port: 0, pageFile, pollMs: 25, log: () => {} });
  try {
    const base = await until(() => dash.url());
    const reader = (await fetch(`${base}/events`)).body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const snapshots = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^event: snapshot\ndata: (.*)$/m.exec(frame);
          if (m) snapshots.push(JSON.parse(m[1]));
        }
      }
    })();
    await until(() => snapshots.length >= 1);
    assert.equal(snapshots[0].run.stages[0].status, "running");
    appendFileSync(stepsFile, [step({ text: "worker-1 done in 3.0s, $0.0000", role: "worker", label: "worker-1", route: "deepseek" }), step({ text: "run done: $0.0000, 1 calls", status: "done" })].join("\n") + "\n");
    const last = await until(() => snapshots.find((x) => x.run?.status === "done"), 4000);
    assert.equal(last.run.stages[0].status, "done", "the stage card changed without a reload");
    await reader.cancel();
    await pump.catch(() => {});
  } finally {
    dash.close();
  }
});

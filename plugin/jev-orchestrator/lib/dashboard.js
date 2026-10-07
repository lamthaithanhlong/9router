// The live dashboard: a tiny HTTP server inside this process that shows a run while it happens.
//
// It reads ONLY the four files the pipeline already writes - the step feed, the run log, the ledger
// and 9Router's read-only SQLite. It never makes a model call and never spends quota: watching a run
// must be free, or nobody watches. The owner asked for the link on every run, so `formatReport`
// prints it and the server is started once per process, not once per run.
//
// Everything here degrades: a missing file is an empty list, a busy port moves to the next one, and
// a failure to listen logs one line and lets the run continue. The dashboard must never be able to
// break a run.
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCostTracker } from "./cost.js";

function expandHome(p) {
  return typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// The step feed is one JSON object per line. A line half-written by a live writer must be dropped,
// not thrown on.
function parseJsonl(text, limit) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line: skip it */ }
  }
  return limit && out.length > limit ? out.slice(-limit) : out;
}

function readJsonl(file, limit) {
  try { return parseJsonl(readFileSync(file, "utf8"), limit); } catch { return []; }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

// Which run the feed is currently on, and whether it has finished. The run log carries no id, so the
// "finished" run is matched by time window against the step feed.
export function currentRun(steps, runs) {
  const last = steps.at(-1);
  if (!last?.run) return null;
  const mine = steps.filter((s) => s.run === last.run);
  if (!mine.length) return null;
  const startedAt = mine[0].ts ?? null;
  const doneLine = [...mine].reverse().find((s) => /^run (done|ended)/.test(s.text ?? ""));
  const endedAt = doneLine?.ts ?? null;
  const run = {
    id: last.run,
    startedAt,
    endedAt,
    status: doneLine ? (doneLine.status ?? (/^run ended/.test(doneLine.text) ? "error" : "done")) : "running",
    cwd: null,
    task: null,
    usd: 0,
    stages: [],
  };
  const logged = [...(runs ?? [])].reverse().find((r) => r.ts && startedAt && r.end && r.ts <= startedAt && r.end >= startedAt);
  // Runs that ended before the closing line existed (or whose process died) have none: the run log, written in
  // a finally, still says when and how they ended.
  if (!doneLine && logged) {
    run.status = logged.status ?? "error";
    run.endedAt = logged.end;
  }
  const source = logged ?? runs?.at(-1) ?? null;
  if (source) {
    run.cwd = source.cwd ?? null;
    run.task = source.task ?? null;
    if (doneLine) run.status = source.status ?? run.status;
  }
  if (doneLine?.usd !== undefined) run.usd = Number(doneLine.usd) || 0;
  return run;
}

// One entry per label in the feed: what ran, on which route, for how long, for how much.
export function stagesOf(steps, runId) {
  const byLabel = new Map();
  for (const s of steps) {
    if (runId && s.run !== runId) continue;
    if (!s.label && !s.role) continue; // "run started" / "run done" belong to the header, not a card
    const key = s.label || s.role || "run";
    if (!byLabel.has(key)) {
      byLabel.set(key, {
        key, label: key, role: s.role ?? key, status: "waiting",
        route: null, model: null, via: null, turn: null,
        startedAt: null, endedAt: null, usd: 0, text: "",
      });
    }
    const st = byLabel.get(key);
    if (s.text) st.text = s.text;
    if (s.route) st.route = s.route;
    if (s.model) st.model = s.model;
    if (s.via) st.via = s.via;
    if (s.turn) st.turn = s.turn;
    const text = s.text ?? "";
    // A child's own lines (what it thought, what a command printed) are model text: they must not be able to
    // say "done in" and flip the card. Only the pipeline's own lines move a stage's status.
    if (s.child) continue;
    if (/started on /.test(text)) { st.status = "running"; st.startedAt = s.ts ?? st.startedAt; }
    if (/(done in |failed in |cancelled after )/.test(text)) {
      st.status = s.status === "error" || /(failed in |cancelled after )/.test(text) ? "failed" : "done";
      st.endedAt = s.ts ?? st.endedAt;
      if (typeof s.usd === "number") st.usd += s.usd;
    }
  }
  return [...byLabel.values()];
}

export function createDashboard({ cfg, ledger, version, log = () => {}, host = "127.0.0.1", port = 8787, pageFile, pollMs = 1000 }) {
  const stepsFile = expandHome(cfg.stepsFile ?? "~/.dsh/jev-steps.jsonl");
  const runsFile = expandHome(cfg.runLog ?? "~/.dsh/jev-runs.jsonl");
  const cost = createCostTracker({ ...cfg, cost: { ...(cfg.cost ?? {}), dbFile: expandHome(cfg.cost?.dbFile ?? "~/.9router/db/data.sqlite") } }, { log });

  async function snapshot() {
    const steps = readJsonl(stepsFile, 400);
    const runs = readJsonl(runsFile, 20);
    const run = currentRun(steps, runs);
    if (run) run.stages = stagesOf(steps, run.id);
    const day = await cost.dayUsd();
    const state = ledger?.load?.() ?? { day: null, used: {} };
    const perRoute = Object.entries(cfg.budgets ?? {})
      .filter(([key, b]) => cfg.routes?.[key] && b && Number.isFinite(b.daily))
      .map(([key, b]) => {
        const used = Number(state.used?.[key] ?? 0) || 0;
        const remaining = b.daily - used;
        return { key, unit: b.unit, used, daily: b.daily, remaining, over: remaining <= 0 };
      });
    const overRoutes = perRoute.filter((r) => r.over).map((r) => r.key);
    return {
      now: new Date().toISOString(),
      version,
      sources: {
        steps: readJsonl(stepsFile, 0).length,
        runs: runs.length,
        ledgerDay: state.day ?? null,
        nineRouter: day !== null,
      },
      run,
      history: [...runs].reverse().map((r) => ({
        ts: r.ts ?? null,
        end: r.end ?? null,
        status: r.status ?? "?",
        task: (r.task ?? "").slice(0, 120),
        usd: (r.trace ?? []).reduce((s, e) => s + (Number(e.usd) || 0), 0),
      })),
      cfo: {
        today: day,
        perRoute,
        wallet: overRoutes.length ? "OVER CAP" : "OK",
        overRoutes,
      },
      steps: steps.slice(-400),
      lastNineRouterCalls: await cost.recentCalls(10),
    };
  }

  // ---- HTTP ----------------------------------------------------------------
  const clients = new Set();
  let offset = 0;
  let carry = "";
  let timer = null;
  let beats = 0;

  function frame(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client left */ }
  }

  function tick() {
    if (!clients.size) return;
    beats += 1;
    if (beats % 15 === 0) for (const res of clients) { try { res.write(": ping\n\n"); } catch { /* gone */ } }
    let size = 0;
    try { size = statSync(stepsFile).size; } catch { return; }
    if (size < offset) { offset = 0; carry = ""; } // rotated or truncated
    if (size <= offset) return;
    let text = "";
    try { text = readFileSync(stepsFile, "utf8").slice(offset); } catch { return; }
    offset = size; // byte offset, but the feed is ASCII-safe JSON; a multi-byte split only costs one re-read
    const parts = (carry + text).split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      for (const res of clients) frame(res, "step", entry);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(await snapshot()));
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      frame(res, "snapshot", await snapshot());
      clients.add(res);
      req.on("close", () => { clients.delete(res); });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readFileSync(pageFile, "utf8"); // read every request: editing the page needs no restart
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`dashboard page unreadable: ${err.message}`);
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  let url = null;
  let listening = false;
  const wanted = Number.isFinite(port) ? port : 8787;
  let attempt = 0;

  server.on("error", (err) => {
    if (!listening && err.code === "EADDRINUSE" && attempt < 9) {
      attempt += 1;
      server.listen(wanted + attempt, host);
      return;
    }
    log(`dashboard: ${err.message}; the run continues without it`);
  });
  server.on("listening", () => {
    listening = true;
    const addr = server.address();
    url = `http://${host}:${addr.port}`;
    offset = 0;
    carry = "";
    timer = setInterval(tick, pollMs);
    timer.unref?.();
    log(`dashboard: ${url} (free to watch: it only reads files)`);
  });
  server.unref?.();
  server.listen(wanted, host);

  return {
    url: () => url,
    port: () => (listening ? server.address()?.port ?? null : null),
    snapshot,
    close() {
      if (timer) clearInterval(timer);
      for (const res of clients) { try { res.end(); } catch { /* gone */ } }
      clients.clear();
      try { server.close(); } catch { /* already closed */ }
    },
  };
}

// Real dollar cost, read from 9Router's SQLite log. 9Router records one row per upstream
// call in `usageHistory` (cost as a USD float, tokens broken out), and one row per UTC day
// in `usageDaily`. The plugin never computes price itself: it sums what 9Router already
// wrote. When 9Router is not installed (no DB, no node:sqlite), every method degrades to
// zero / null so the pipeline still works.
//
// The tracker also keeps a per-route rolling average of USD-per-call so `assumeUsd` improves
// during a run. The configured `cfg.cost.assume[routeKey]` always wins over the rolling
// average: the owner's manual override beats the learned number.

import { homedir } from "node:os";
import { join } from "node:path";

let DatabaseSync = null;
let sqliteOk = false;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
  sqliteOk = true;
} catch {
  // node:sqlite is unavailable. The tracker falls back to the zero / null answers.
}

// Same defence as lib/steps.js: a caller that hands us a raw "~/.9router/..." (the default
// below is written that way) must not silently lose every cost number because a tilde was
// never expanded. index.js does expand, but the module cannot rely on that.
function expandHome(p) {
  return typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function createCostTracker(cfg, { log = () => {} } = {}) {
  const costCfg = cfg.cost || {};
  const configured = typeof costCfg.dbFile === "string" && costCfg.dbFile ? costCfg.dbFile : "~/.9router/db/data.sqlite";
  const dbFile = expandHome(configured);
  let db = null;
  let warned = false;
  const note = (msg) => { if (!warned) { warned = true; log(msg); } };

  if (sqliteOk && typeof dbFile === "string" && dbFile.length > 0) {
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
    } catch (err) {
      note(`cost tracker: 9Router DB unavailable (${err.message || err}); every cost method returns zero`);
      db = null;
    }
  } else if (!sqliteOk) {
    note("cost tracker: node:sqlite unavailable; every cost method returns zero");
  }

  // Last observed USD-per-call per route key (exponential average, weight 0.5).
  const avg = new Map();
  let spent = 0; // accumulator for the current jev_run (the "task")

  return {
    // Highest usageHistory.id seen, or -1 if the DB is missing. Used as a watermark.
    snapshot() {
      if (!db) return -1;
      try {
        const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM usageHistory").get();
        return Number(row?.m ?? -1);
      } catch (err) {
        note(`cost.snapshot failed: ${err.message || err}`);
        return -1;
      }
    },

    // Sum cost rows with id > sinceId. Rows are attributed by provider/model when both are
    // given and at least one matching row exists; otherwise the whole post-watermark window
    // counts (children run in parallel, so an unmatched row is still this run's spend).
    async reconcile(sinceId, { routeKey, provider, model } = {}) {
      if (!db) return { usd: 0, calls: 0 };
      try {
        const rows = db.prepare("SELECT id, cost, provider, model FROM usageHistory WHERE id > ? ORDER BY id ASC").all(sinceId);
        const matched = (rows.length && provider && model)
          ? rows.filter((r) => r.provider === provider && r.model === model)
          : rows;
        const use = matched.length > 0 ? matched : rows;
        const usd = use.reduce((s, r) => s + (Number(r.cost) || 0), 0);
        const calls = use.length;
        // Learn per-call cost for this route (exponential average, weight 0.5).
        if (calls > 0 && routeKey) {
          const per = usd / calls;
          const prev = avg.get(routeKey);
          avg.set(routeKey, prev === undefined ? per : prev * 0.5 + per * 0.5);
        }
        return { usd, calls };
      } catch (err) {
        note(`cost.reconcile failed: ${err.message || err}`);
        return { usd: 0, calls: 0 };
      }
    },

    // Estimate the cost of the next call on this route BEFORE it runs. Manual override wins,
    // then the rolling average from reconcile(), then 0.
    assumeUsd(routeKey) {
      const configured = costCfg.assume?.[routeKey];
      if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) return configured;
      const a = avg.get(routeKey);
      return typeof a === "number" ? a : 0;
    },

    // Accumulator for the current jev_run.
    chargeTaskUsd(usd) { if (Number.isFinite(usd)) spent += usd; },
    taskUsd() { return spent; },

    async dayUsd() {
      if (!db) return null;
      try {
        const dateKey = new Date().toISOString().slice(0, 10);
        const row = db.prepare("SELECT data FROM usageDaily WHERE dateKey = ?").get(dateKey);
        if (!row) return { dateKey, usd: 0, requests: 0 };
        const d = JSON.parse(row.data);
        return { dateKey, usd: Number(d.cost) || 0, requests: Number(d.requests) || 0 };
      } catch (err) {
        note(`cost.dayUsd failed: ${err.message || err}`);
        return null;
      }
    },

    async recentCalls(limit = 10) {
      if (!db) return [];
      try {
        const n = Math.max(1, Math.min(500, Number(limit) || 10));
        const rows = db.prepare("SELECT timestamp, provider, model, promptTokens, completionTokens, cost FROM usageHistory ORDER BY id DESC LIMIT ?").all(n);
        return rows.map((r) => ({
          timestamp: r.timestamp,
          provider: r.provider,
          model: r.model,
          promptTokens: Number(r.promptTokens) || 0,
          completionTokens: Number(r.completionTokens) || 0,
          cost: Number(r.cost) || 0,
        }));
      } catch (err) {
        note(`cost.recentCalls failed: ${err.message || err}`);
        return [];
      }
    },
  };
}
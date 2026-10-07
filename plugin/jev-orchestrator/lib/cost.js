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

// Does one `usageHistory` row belong to this route? `usage` is { provider?, model? }; each field
// is an exact string, a list of them, or a single trailing-* glob, compared case-insensitively.
// A field that is absent does not constrain the match; an empty descriptor matches nothing.
// Exported so the tests can pin this down without a live 9Router DB.
export function matchUsage(row, usage) {
  if (!usage || typeof usage !== "object") return false;
  const ok = (value, patterns) => {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const v = String(value ?? "").toLowerCase();
    return list.some((p) => {
      const s = String(p ?? "").toLowerCase();
      if (!s) return false;
      return s.endsWith("*") ? v.startsWith(s.slice(0, -1)) : v === s;
    });
  };
  const fields = ["provider", "model"].filter((f) => usage[f] !== undefined);
  if (fields.length === 0) return false;
  return fields.every((f) => ok(row[f], usage[f]));
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

    // Sum the cost rows with id > sinceId that belong to THIS route. Attribution is the whole
    // problem here, and getting it wrong is worse than getting it zero:
    //   9Router logs the RESOLVED upstream call, not the combo we asked for. Our route "codex" is
    //   router9/codex-head, but the row says provider "codex", model "gpt-6.1-sol"; our route
    //   "deepseek" is deepseek-host/deepseek-v4.1-flash, and the row says provider
    //   "openai-compatible-chat-<uuid>". Matching on our own identifiers matched ZERO rows of the
    //   2457+ in this DB, and the old fallback then counted EVERY row in the window - the head
    //   agent's own calls and every other app on the machine included. On 2026-10-07 one worker
    //   was billed $3.5211 that way, the task wallet blew past its $0.10 cap, and the run was
    //   pushed off deepseek onto Cursor, where it hung 627s and produced nothing.
    // So: match with the route's `usage` descriptor, and when nothing matches charge NOTHING and
    // report `unmatched`. Under-charging hides spend; over-charging silently kills the run.
    async reconcile(sinceId, { routeKey, usage, provider, model } = {}) {
      if (!db) return { usd: 0, calls: 0, unmatched: 0 };
      try {
        const rows = db.prepare("SELECT id, cost, provider, model FROM usageHistory WHERE id > ? ORDER BY id ASC").all(sinceId);
        const desc = usage ?? (provider && model ? { provider, model } : null);
        const use = desc ? rows.filter((r) => matchUsage(r, desc)) : [];
        if (use.length === 0) {
          if (rows.length > 0) {
            note(`cost: no 9Router row matched route ${routeKey ?? "?"} (${JSON.stringify(desc)}); charged $0 for ${rows.length} row(s) in the window`);
          }
          return { usd: 0, calls: 0, unmatched: rows.length };
        }
        const usd = use.reduce((s, r) => s + (Number(r.cost) || 0), 0);
        const calls = use.length;
        // Learn per-call cost for this route (exponential average, weight 0.5). One logical call
        // that a retry combo turned into N upstream rows teaches N times the prompt price here,
        // which is exactly what should make the per-call cap refuse that route next time.
        if (routeKey) {
          const per = usd / calls;
          const prev = avg.get(routeKey);
          avg.set(routeKey, prev === undefined ? per : prev * 0.5 + per * 0.5);
        }
        return { usd, calls, unmatched: rows.length - calls };
      } catch (err) {
        note(`cost.reconcile failed: ${err.message || err}`);
        return { usd: 0, calls: 0, unmatched: 0 };
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
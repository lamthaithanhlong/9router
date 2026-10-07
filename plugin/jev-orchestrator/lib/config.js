import { homedir } from "node:os";
import { join } from "node:path";

export const NAME = "jev-orchestrator";

// Route keys point at provider/model pairs registered in the Harness profile
// (cordis.patch.yml, entry llm-pi-ai). Provider "router9" is 9Router; its
// models are 9Router combos. A role never names a model: it names a chain of
// route keys (CHAINS), cheapest acceptable first.
export const DEFAULTS = {
  subagentProvider: "spawn",
  toolName: "jev_run",
  toolTimeoutMs: 3_600_000,

  routes: {
    codex: { provider: "router9", model: "codex-head", cost: "quota", group: "codex" },
    cursor: { provider: "router9", model: "cursor-workers", cost: "free", group: "cursor" },
    manager: { provider: "router9", model: "manager-temp", cost: "free", group: "cursor" }, // also Cursor: shares its cap
    deepseek: { provider: "deepseek-host", model: "deepseek-v4.1-flash", cost: "money", group: "deepseek" },
    // Last resort when everything above is out of quota or failing: a 9Router combo of free OpenCode and
    // OpenRouter models, tried in order. The combo itself is made in the 9Router dashboard
    // (PLUGIN-TEMPLATE.md section 11.8); it must also be listed under router9 in the Harness profile.
    backup: { provider: "router9", model: "backup-free", cost: "free", backup: true, group: "backup" },
    // The Cursor APP as a worker, through files (lib/queue.js): the plugin writes a task into cursorQueue.dir and a
    // person tells the app to process it. Not on any chain by default: enable it with, in the plugin config,
    //   chains: { worker: [cursorqueue, backup] }
    // A task nobody picks up within cursorQueue.waitMs is withdrawn and the next route on the chain takes it.
    cursorqueue: { kind: "queue", provider: "cursor-app", model: "queue", cost: "free", group: "cursorqueue" },
    // External OpenAI-compatible HTTP API routes (lib/api.js). Disabled by default: with api.enabled false
    // they are removed from `routes` and from every chain, so a config that does not opt in sees nothing.
    // Enable with config: api: { enabled: true }. The model, baseUrl and keyEnv are the defaults; a 9Router
    // deployment is added by config alone (a route with provider "api" + the env var it points at).
    api_deepseek: { provider: "api", model: "deepseek-v4.1-flash", cost: "money", group: "api",
      api: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-chat" } },
    api_openrouter: { provider: "api", model: "openrouter-auto", cost: "money", group: "api",
      api: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", model: "openrouter/auto" } },
  },

  cursorQueue: {
    dir: "~/.dsh/cursor-queue",
    waitMs: 300_000, // how long a task may sit unclaimed
    claimedWaitMs: 1_800_000, // how long a claimed task may take
    pollMs: 2_000,
    settleMs: 2_000, // a result file must have stopped changing this long before it is read
  },

  // A role whose chain is out of budget is held for a human. It never spills
  // onto a route that is not on its own chain.
  chains: {
    planner: ["codex", "manager", "backup"],
    researcher: ["codex", "manager", "backup"],
    worker: ["cursor", "backup"],
    reviewer: ["deepseek", "codex", "backup"],
    final_reviewer: ["codex", "backup"],
  },

  // A review that only a backup (free) model gave is weaker than one from the primary reviewers.
  // By default a diff that triggered review and was approved ONLY by backup reviewers still ends
  // awaiting_human. Set reviewIsFinal: true to accept a backup approval.
  backupPolicy: { reviewIsFinal: false },

  // Placeholder numbers: set them from the real Codex quota and DeepSeek
  // spend limit. Routes without an entry are unmetered.
  budgets: {
    codex: { unit: "calls", daily: 40, reserveFraction: 0.2, reserveFor: ["final_reviewer"] },
    deepseek: { unit: "tokens", daily: 300_000, reserveFraction: 0, reserveFor: [] },
    // Placeholder daily cap per external API route so a runaway loop cannot spend without limit.
    // Tune to the real upstream quota in production; the number below is only a safety net.
    api_deepseek: { unit: "tokens", daily: 200_000, reserveFraction: 0, reserveFor: [] },
    api_openrouter: { unit: "tokens", daily: 200_000, reserveFraction: 0, reserveFor: [] },
  },
  ledgerFile: "~/.dsh/jev-ledger.json",
  runLog: "~/.dsh/jev-runs.jsonl", // one line per jev_run: who ran, on what, how long

  // Tools a child agent is not offered. Measured in the real Harness: without this a
  // worker is offered jev_run, subagent, subagent_fork and workflow, i.e. it can start
  // more agents on models nobody budgeted. Roles other than worker also lose the
  // file-writing tools: a reviewer or researcher that edits files defeats its role.
  childTools: {
    denyAll: ["jev_run", "subagent", "subagent_fork", "workflow"],
    denyNonWorker: ["write", "edit"],
  },

  limits: {
    maxFixRounds: 2,
    maxReviewRounds: 2,
    researchDigestWords: 300,
    maxDiffChars: 60_000,
    assumedOutputTokens: 1_500,
    testTimeoutMs: 600_000,
    // After a route fails at run time it is skipped for this long, so the next calls go straight to the next route.
    routeCooldownMs: 600_000,
    // Children running at once per upstream group, across ALL jev_run calls. More are queued, not refused.
    // Cursor (cursor-workers and manager-temp) is capped at 3 because it rate-limited the owner.
    concurrency: { cursor: 3, codex: 2, deepseek: 2, backup: 2, cursorqueue: 3 },
    // Minimum gap between two child starts in a group, so a burst is spread out instead of landing at once.
    startGapMs: { cursor: 2000, codex: 1000, deepseek: 500, backup: 1000, cursorqueue: 0 },
    // One call may carry at most this many sub-tasks / research questions; more is refused with a message.
    maxTasks: 6,
    maxResearch: 3,
    // One HTTP call to an api route may take at most this long; on hit we abort and throw.
    apiTimeoutMs: 300_000,
  },

  // Gate 2 (the paid reviewer) runs when one of these fires. They are computed
  // by code; no model can switch them off.
  gate2: {
    diffLines: 150,
    testFailStreak: 2,
    riskyPaths: [
      "**/auth/**",
      "**/*auth*",
      "**/*billing*",
      "**/*payment*",
      "**/migrations/**",
      "**/*.sql",
      "**/.github/**",
      "**/Dockerfile",
      "**/.env*",
      "**/config/**",
    ],
  },

  // Laya answers yes/no questions as probabilities. It can only ADD a reason
  // to spend (plan, review); it never removes one that the rules above set.
  // Measured on this machine (2026-10-06, zero-shot): needs_plan separates simple
  // from complex English tasks (<=0.16 vs 0.71-0.76) but misses some, and reads
  // Vietnamese as "no plan" (0.06 for a Redis->Postgres migration); needs_review
  // gave risky diffs 0.19-0.33, no higher than trivial ones (0.18-0.25), so it
  // is off until it is fine-tuned on your own diffs (laya-train).
  laya: {
    enabled: true,
    planEnabled: true,
    reviewEnabled: false,
    englishOnly: true, // skip Laya for tasks that are not plain English text
    url: "http://127.0.0.1:8130",
    timeoutMs: 30_000, // first call after an idle unload loads the checkpoints
    planThreshold: 0.5,
    reviewThreshold: 0.6,
    ctl: "~/.local/bin/laya-ctl", // started in the background when Laya is down
    restartCooldownMs: 300_000,
  },

  // Used when Laya is down.
  heuristics: { planChars: 400 },

  // External OpenAI-compatible HTTP API routes (lib/api.js). Off by default: the api_* routes are
  // stripped from `routes` and from every chain until api.enabled is true, so a config that does not
  // opt in sees no API at all. On opt-in, api routes are inserted right before `backup` in the four
  // text-only chains (planner, researcher, reviewer, final_reviewer); the worker chain is untouched.
  api: { enabled: false },
};

export function expandHome(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const isPlain = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// User config from cordis.patch.yml is merged over DEFAULTS key by key;
// arrays and scalars replace.
export function resolveConfig(user = {}) {
  const merge = (base, over) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(over ?? {})) {
      out[k] = isPlain(v) && isPlain(base[k]) ? merge(base[k], v) : v;
    }
    return out;
  };
  const cfg = merge(DEFAULTS, user);
  // API routes (provider === "api") are opt-in. Off: strip every api route from `routes` and from
  // every chain so a config that does not opt in is byte-for-byte the old behaviour. On: keep them
  // in `routes`, and in the four text-only chains insert any not already present directly before
  // `"backup"` (in their listing order in `routes`). The worker chain is untouched either way.
  const apiKeys = Object.keys(cfg.routes).filter((k) => cfg.routes[k]?.provider === "api");
  const apiOn = cfg.api?.enabled === true;
  if (apiOn) {
    for (const role of ["planner", "researcher", "reviewer", "final_reviewer"]) {
      const chain = cfg.chains[role];
      if (!Array.isArray(chain)) continue;
      const already = new Set(chain);
      const added = apiKeys.filter((k) => !already.has(k));
      if (added.length === 0) continue;
      const at = chain.indexOf("backup");
      cfg.chains[role] = at > 0 ? [...chain.slice(0, at), ...added, ...chain.slice(at)] : [...chain, ...added];
    }
  } else if (apiKeys.length > 0) {
    const dropped = new Set(apiKeys);
    const next = {};
    for (const [k, v] of Object.entries(cfg.routes)) if (!dropped.has(k)) next[k] = v;
    cfg.routes = next;
    for (const [role, chain] of Object.entries(cfg.chains)) {
      cfg.chains[role] = Array.isArray(chain) ? chain.filter((k) => !dropped.has(k)) : chain;
    }
  }
  return cfg;
}

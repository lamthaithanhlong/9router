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
    // `usage` is how the call is found again in 9Router's `usageHistory` after it happened.
    // Our own provider id and the combo name are useless for that: 9Router records the RESOLVED
    // upstream call, so the combo codex-head appears as provider "codex" with a model like
    // "gpt-6.1-sol". Matching on "router9"/"codex-head" matched NOTHING, and an unmatched route
    // was then charged every row in the window (lib/cost.js reconcile) - i.e. other apps' traffic.
    // Values are exact strings or a single trailing-* glob, compared case-insensitively.
    codex: { provider: "router9", model: "codex-head", cost: "quota", group: "codex", usage: { provider: "codex" } },
    // Cursor through 9Router must be probed before a child is committed to it: it can answer
    // HTTP 200 with no text (ERROR_NOT_LOGGED_IN inside the stream, which 9Router records as
    // "[Empty streaming response]" and counts as success). A child that finds out the slow way
    // burns ~70s and, per the run log, has taken 1638s to abort. See lib/probe.js.
    cursor: { provider: "router9", model: "cursor-workers", cost: "free", group: "cursor", probe: true,
      usage: { provider: "cursor" } },
    // The manager office: a SEAT, not a model. Codex and DeepSeek-host hold it alternately, so
    // neither one's quota nor its wallet decides the job alone. The old manager-temp (a Cursor
    // combo) is gone: it answered HTTP 200 with an empty body, and a seat nobody can sit in is
    // worse than no seat. lib/roles.js expands this; the members keep their own group, cost and
    // probe flags, and the ledger is charged to the member, never to "manager".
    manager: { rotate: ["codex", "deepseek"] },
    deepseek: { provider: "deepseek-host", model: "deepseek-v4.1-flash", cost: "money", group: "deepseek",
      // The 9Router node this route points at is stored as "openai-compatible-chat-<uuid>" and the
      // uuid changes if the owner re-creates the node, so match on the stable prefix + model.
      usage: { provider: "openai-compatible-chat-*", model: "deepseek-v4.1-flash" } },
    // Last resort when everything above is out of quota or failing: a 9Router combo of free OpenCode and
    // OpenRouter models, tried in order. The combo itself is made in the 9Router dashboard
    // (PLUGIN-TEMPLATE.md section 11.8); it must also be listed under router9 in the Harness profile.
    backup: { provider: "router9", model: "backup-free", cost: "free", backup: true, group: "backup",
      usage: { provider: ["opencode", "openrouter"] } },
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
    planner: ["manager", "backup"],
    researcher: ["manager", "backup"],
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
    // Counted in CALLS, not tokens: the plan's quota - not the money ($0.042/Mtok
    // input) - is the scarce resource. The owner asked for up to 70 hosted
    // questions a day; if the plan actually stops earlier, the client marks the
    // hosted route exhausted for the rest of the UTC day (see lib/laya.js) and the
    // free local engine answers, so the extra attempts cost one failed round-trip
    // in total, not one per question.
    laya: { unit: "calls", daily: 70, reserveFraction: 0, reserveFor: [] },
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
    // Cursor (cursor-workers) is capped at 3 because it rate-limited the owner.
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
    // Hosted Jev by default (TypeSafe), with the free local laya-serve as the
    // fallback below. No key resolves -> only the fallback is ever called, which
    // is exactly the old behaviour.
    url: "https://api.typesafe.ai",
    keyEnv: "", // e.g. TYPESAFE_API_KEY; the environment wins when it is set
    keyFile: "~/.dsh/jev/typesafe.key", // 0600 file, used when the env var is not set
    model: "jev-latest",
    fallbackUrl: "http://127.0.0.1:8130",
    timeoutMs: 30_000, // first call after an idle unload loads the checkpoints
    planThreshold: 0.5,
    reviewThreshold: 0.6,
    ctl: "~/.local/bin/laya-ctl", // started in the background when Laya is down
    restartCooldownMs: 300_000,
  },

  // Used when Laya is down.
  heuristics: { planChars: 400 },

  // One file in JSON Lines per call the pipeline is about to make or just made, so
  // `node watch.mjs` and `jev_watch` can show progress for free (no model call).
  stepsFile: "~/.dsh/jev-steps.jsonl",

  // Real dollar cost: read from 9Router's SQLite (`usageHistory`, `usageDaily`) and
  // throttled per child call and per task. Caps only apply to `cost === "money"`
  // routes; free or quota routes are still measured and reported, never refused.
  cost: {
    enabled: true,            // when false: tracker methods still work, but the caps below are inert
    dbFile: "~/.9router/db/data.sqlite", // where 9Router keeps its call log
    callUsd: 0.001,           // cap for ONE child call; over it -> next affordable route on the chain
    taskUsd: 0.08,            // cap for ONE jev_run (all roles, all calls); over it -> awaiting_human
    enforce: true,            // false = warn only, never refuse the call
    // Manual USD-per-call per route. Wins over the rolling average the tracker learns in-process.
    assume: {},               // { routeKey: usdPerCall } -- e.g. { cursor: 0.0335 }
  },

  // Ask before committing a child to a route that is known to answer nothing. Only routes whose
  // definition carries `probe: true` (cursor, today) are asked; probing codex, deepseek or
  // backup would spend quota or money to learn nothing. See lib/probe.js.
  probe: {
    enabled: true,
    baseUrl: "http://127.0.0.1:20128", // 9Router; the probe is a plain OpenAI /chat/completions call
    timeoutMs: 15_000,  // a route that has not said PONG by now is not worth a child's time
    ttlMs: 300_000,     // how long one answer is trusted; a good answer is not re-asked per call
    dataDir: "~/.9router", // machine-id + auth/cli-secret live here, for the x-9r-cli-token header
    // Generous on purpose. These routes are reasoning models: the thinking tokens come out of the
    // same budget, so a small max_tokens truncates the visible answer. Measured on cursor-workers:
    // max_tokens 8 -> "" or "P"; max_tokens 64 -> "PONG" three times out of three (completion_tokens
    // 33, 30, 11). A probe that starves the answer reports a healthy route as dead — which is worse
    // than no probe at all.
    maxTokens: 256,
  },

  // The owner asked for a second opinion rather than a single reviewer verdict. `crossCheck`
  // lists route keys; after the primary reviewer approves, each named route reads the same plan
  // and diff. A split verdict never merges on its own. Empty by default (opt in from config).
  review: {
    crossCheck: [],              // e.g. ["codex", "deepseek"]
    onDisagree: "awaiting_human", // the only value implemented today
  },

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

// jev-orchestrator: one tool, `jev_run`, that runs a coding task through
// cost-aware roles. Cursor workers do the work; Codex plans and researches;
// DeepSeek reviews only the diffs that need it; Laya (local, free) answers the
// yes/no questions. See README.md and ../../PLUGIN-TEMPLATE.md.
//
// Cordis plugin contract: export `name`, `inject` and `apply(ctx, config)`.
// No `Config` schema and no @deepseek-ai/* imports: the module has no runtime
// dependencies, so it loads from a plain relative path in cordis.patch.yml.
import { existsSync, readFileSync } from "node:fs";
import { createApiSpawn } from "./lib/api.js";
import { createCostTracker } from "./lib/cost.js";
import { createProbe } from "./lib/probe.js";
import { createLaya } from "./lib/laya.js";
import { Ledger } from "./lib/budget.js";
import { RouteHealth } from "./lib/health.js";
import { Limiter } from "./lib/limiter.js";
import { createSteps } from "./lib/steps.js";
import { ToolFilter, denyFor } from "./lib/toolfilter.js";
import { getChanges, runTests } from "./lib/changes.js";
import { NAME, expandHome, resolveConfig } from "./lib/config.js";
import { formatReport, runPipeline } from "./lib/pipeline.js";
import { recordRun } from "./lib/runlog.js";
import { createQueue, idSource } from "./lib/queue.js";
import { cfoLine } from "./lib/telemetry.js";

// package.json is the single source of truth for the version.
function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}
export const version = readVersion();

export const name = NAME;
export const inject = ["tools", "subagents"];

const PROMPT_FILE = {
  planner: "planner",
  researcher: "researcher",
  worker: "worker",
  reviewer: "reviewer",
  final_reviewer: "reviewer",
};
const loadPrompt = (role) => readFileSync(new URL(`./prompts/${PROMPT_FILE[role]}.md`, import.meta.url), "utf8");

export { denyFor };

// Run one child agent through the Harness subagent service and return its text.
async function spawnChild(ctx, cfg, exec, route, prompt, label, role, { filter, log = () => {}, note = () => {} }) {
  const maxDepth = ctx.subagents.resolveMaxDepth(undefined);
  const start = (deny) =>
    ctx.subagents.start(cfg.subagentProvider, {
      label,
      prompt: [{ type: "text", text: prompt }],
      parent: exec.agent,
      agentOptions: { provider: route.provider, model: route.model },
      toolFilter: { deny },
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      signal: exec.signal,
    });
  let run;
  // Each retry sends a strictly smaller filter (learn() only returns names that attempt sent), so this ends.
  for (;;) {
    const sent = filter.deny(role); // what THIS attempt sends; learn() needs it, not the filter as it is later
    try {
      run = await start(sent);
      break;
    } catch (error) {
      const dropped = filter.learn(error, sent);
      if (dropped.length === 0) throw error;
      const names = dropped.map((n) => `"${n}"`).join(", ");
      log(`this Harness refuses naming ${names} in a child tool filter; dropped, retrying`);
      note(`child tool filter: this Harness does not let a filter name ${names}, so children may be offered ${dropped.join(", ")} (the depth limit still stops them from delegating)`);
    }
  }
  const [result] = await Promise.allSettled([run.result]);
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (result.status === "rejected") throw result.reason;
  if (disposal.status === "rejected") throw disposal.reason;
  const { stopReason, output, diagnostic } = result.value;
  const text = output.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (stopReason !== "completed") {
    throw new Error(`${label} ended with ${stopReason}${diagnostic ? `: ${diagnostic}` : ""}${text ? `\nPartial output:\n${text}` : ""}`);
  }
  return text;
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() !== "") : []);

export function newLimiter(cfg) {
  return new Limiter({ limits: cfg.limits.concurrency, gaps: cfg.limits.startGapMs });
}

// The tool definition is written as the compiled JSON Schema form that the
// Harness's own defineTool() produces, so this file needs no import for it.
// dev/verify-against-harness.mjs checks it against the real defineTool().
export function newQueue(cfg) {
  return createQueue({ ...cfg.cursorQueue, dir: expandHome(cfg.cursorQueue.dir) });
}

export function buildTool(ctx, cfg, ledger, log = () => {}, health = new RouteHealth(cfg.limits.routeCooldownMs), limiter = newLimiter(cfg), filter = new ToolFilter(cfg), queue = newQueue(cfg), probe = null, rotation = new Map()) {
  const laya = createLaya(cfg.laya, { log });
  const apiSpawn = createApiSpawn(cfg, { log });
  return {
    name: cfg.toolName,
    description:
      "Run a coding task in a git repository through the cost-aware pipeline: Cursor workers make the change and run the tests, " +
      "Codex plans and researches when that is worth its quota, and a paid DeepSeek/Codex review runs only when the diff is large, " +
      "touches risky paths, strays outside allowed_paths, or the tests were red twice. Use it for real code changes, not for questions. " +
      "Models are chosen by role, not by you. Returns a report; status awaiting_human means a person must decide.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to change, with enough context for an agent that has not seen this conversation." },
        cwd: { type: "string", description: "Absolute path of the git repository (ideally a dedicated worktree) to work in." },
        tasks: { type: "array", items: { type: "string" }, description: "Optional independent sub-tasks for parallel workers. Omit to run `task` with one worker. At most 3 workers run at the same time (Cursor rate-limits); extra sub-tasks wait their turn, and more than 6 are refused: split the work into separate calls." },
        research: { type: "array", items: { type: "string" }, description: "Optional questions for a researcher (GitHub, library source, docs). Each costs Codex quota; omit if the answer is not outside the repo." },
        allowed_paths: { type: "array", items: { type: "string" }, description: "Optional glob patterns the workers may change, e.g. src/**. Changes outside them trigger a review." },
        test_command: { type: "string", description: "Shell command that exits 0 when tests pass, run in cwd. Without it, green means untested." },
        plan: { type: "string", description: "yes, no or auto (default). auto lets Laya decide whether a written plan is needed." },
        final_review: { type: "boolean", description: "Force the Codex check before merge even when no trigger fired." },
      },
      required: ["task", "cwd"],
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    timeoutMs: cfg.toolTimeoutMs,
    async execute(args, exec) {
      if (!exec.agent) throw new Error(`${cfg.toolName} requires a calling agent (exec.agent was undefined)`);
      const tasks = strings(args.tasks);
      const research = strings(args.research);
      if (tasks.length > cfg.limits.maxTasks) throw new Error(`jev_run refused: ${tasks.length} sub-tasks is more than the limit of ${cfg.limits.maxTasks}; split the work into separate calls`);
      if (research.length > cfg.limits.maxResearch) throw new Error(`jev_run refused: ${research.length} research questions is more than the limit of ${cfg.limits.maxResearch}`);
      const input = {
        task: args.task,
        cwd: args.cwd,
        tasks: tasks.length ? tasks : [args.task],
        research,
        allowedPaths: strings(args.allowed_paths),
        testCommand: typeof args.test_command === "string" ? args.test_command : "",
        plan: args.plan === "yes" || args.plan === "no" ? args.plan : "auto",
        finalReview: args.final_review === true,
      };
      let last;
      const trace = [];
      const stamp = Date.now().toString(36); // run id: one per jev_run; shared by every step line and every task id
      const nextTaskId = idSource(stamp);
      // Cost tracker + step writer are fresh per run so the per-task accumulator starts at zero.
      const cost = cfg.cost?.enabled !== false
        ? createCostTracker({ ...cfg, cost: { ...cfg.cost, dbFile: expandHome(cfg.cost.dbFile) } }, { log })
        : null;
      const steps = createSteps({ ...cfg, stepsFile: expandHome(cfg.stepsFile) }, { log });
      steps.step("run started", { run: stamp });
      const deps = {
        trace,
        health,
        limiter,
        rotation, // the manager seat's turn counter, shared by every jev_run in this process
        aborted: () => exec.signal?.aborted === true,
        cfg,
        ledger,
        laya,
        log,
        cost,
        steps,
        probe,
        runId: stamp,
        loadPrompt,
        spawn: (route, prompt, label, role) => {
          if (route.provider === "api") {
            // A text-only role on an external HTTP API: no Harness child is started.
            return apiSpawn(route, prompt, label, role);
          }
          if (route.kind === "queue") {
            // A person-driven app takes this task through files; no Harness child is started.
            const id = nextTaskId(label);
            log(`${label} queued for the Cursor app as ${id}`);
            return queue.submit({ id, label, role, cwd: args.cwd, prompt, signal: exec.signal });
          }
          return spawnChild(ctx, cfg, exec, route, prompt, label, role, {
            filter,
            log,
            // deps.notes belongs to the run in progress; each distinct note is added once
            note: (msg) => { if (deps.notes && !deps.notes.includes(msg)) deps.notes.push(msg); },
          });
        },
        getChanges: async (cwd) => (last = await getChanges(cwd, cfg.limits.maxDiffChars)),
        runTests: (cwd, command) => runTests(cwd, command, cfg.limits.testTimeoutMs),
      };
      const started = Date.now();
      let status = "error";
      let error;
      try {
        const outcome = await runPipeline(deps, input);
        status = outcome.status;
        // Pull today's spend from 9Router before formatting; the report always shows a Cost line when cost is on.
        const day = cost ? await cost.dayUsd() : null;
        const costInfo = cost
          ? { thisTask: cost.taskUsd(), day, taskCap: cfg.cost.taskUsd, callCap: cfg.cost.callUsd }
          : null;
        const text = formatReport(outcome, last, version, costInfo);
        const calls = trace.filter((t) => t.role !== "laya").length;
        steps.step(`run done: $${(cost?.taskUsd() ?? 0).toFixed(4)}, ${calls} calls`, { run: stamp, status, calls, usd: cost?.taskUsd() ?? 0 });
        return text;
      } catch (err) {
        error = err.message;
        throw err;
      } finally {
        recordRun(expandHome(cfg.runLog), {
          version,
          ts: new Date(started).toISOString(),
          end: new Date().toISOString(),
          status,
          ...(error ? { error } : {}),
          task: args.task.slice(0, 200),
          cwd: args.cwd,
          trace,
        });
      }
    },
  };
}

// `jev_watch` — a read-only companion tool that tells the owner what a run is up to
// without spending a model call: the step feed is already on disk, and 9Router's
// SQLite log is read-only. Registered only when cost tracking is enabled.
export function buildWatchTool(ctx, cfg, ledger, log = () => {}, cost) {
  const stepsFile = expandHome(cfg.stepsFile);
  return {
    name: "jev_watch",
    description:
      "Free progress view: the last lines from the step feed, today's spend via 9Router, the last 10 upstream calls, " +
      "and the current ledger. Performs no model call and no subagent call — reads files and the read-only SQLite handle only.",
    parameters: {
      type: "object",
      properties: {
        lines: { type: "number", description: "How many step lines to print (default 30)." },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      if (!exec.agent) throw new Error("jev_watch requires a calling agent (exec.agent was undefined)");
      const limit = Number.isFinite(args.lines) ? Math.max(1, Math.min(500, args.lines)) : 30;
      const stamp = (t) => new Date(t).toISOString().slice(11, 19);
      const out = [];
      // 0. CFO block — three-line header the dashboard (`ui.mjs`) and this CLI share.
      try {
        const cfo = await cfoLine(cfg, ledger.load());
        out.push(...cfo);
      } catch (err) {
        out.push(`CFO: (unavailable: ${err.message})`);
      }
      // 1. Step feed (newest last). Parse the JSON line so we can pick a friendly text and the timestamp.
      out.push("", `Steps (${escape(sinceFileName(stepsFile))}):`);
      try {
        const raw = readFileSync(stepsFile, "utf8");
        const entries = raw.split("\n").filter(Boolean).slice(-limit);
        for (const line of entries) {
          try {
            const e = JSON.parse(line);
            out.push(`  ${stamp(Date.parse(e.ts) || Date.now())}  ${String(e.text || "").slice(0, 160)}`);
          } catch {
            out.push(`  ${line.slice(0, 160)}`);
          }
        }
        if (!entries.length) out.push("  (none yet)");
      } catch (err) {
        out.push(`  (unreadable: ${err.message})`);
      }
      // 2. Today's spend + recent upstream calls via 9Router.
      if (cost) {
        try {
          const day = await cost.dayUsd();
          out.push("", `Today (${day?.dateKey || "?"}): ${day ? `$${day.usd.toFixed(4)} via 9Router, ${day.requests} calls` : "n/a"}`);
        } catch { out.push("", "Today: n/a"); }
        try {
          const recent = await cost.recentCalls(10);
          if (recent.length) {
            out.push("Last 9Router calls:");
            for (const r of recent) {
              out.push(`  ${stamp(new Date(r.timestamp).getTime())}  ${String(r.provider).padEnd(11)} ${String(r.model).padEnd(22)} $${r.cost.toFixed(4)}  ${r.promptTokens}/${r.completionTokens} tok`);
            }
          } else out.push("Last 9Router calls: (none)");
        } catch { out.push("Last 9Router calls: n/a"); }
      }
      // 3. Today's ledger (per-route spend).
      try {
        const state = ledger.load();
        out.push("", `Ledger (${state.day}):`);
        const used = Object.entries(state.used || {}).filter(([, v]) => v > 0);
        out.push(used.length ? used.map(([k, v]) => `  ${k}: ${v}`).join("\n") : "  (nothing yet)");
      } catch { out.push("", "Ledger: (missing)"); }
      return out.join("\n");
    },
  };
}

function sinceFileName(p) { return p.split("/").slice(-1)[0]; }
function escape(s) { return String(s).replace(/[\r\n]/g, " "); }

// `jev_probe` — the single call that answers "is that route actually returning anything?".
// It asks every route marked `probe: true` and prints a table. It shares the cached probe with
// the pipeline, so running jev_probe just before a jev_run makes that run's own probes free.
export function buildProbeTool(ctx, cfg, log = () => {}, probe) {
  return {
    name: "jev_probe",
    description:
      "Ask every route that can go silent whether it really answers. One small upstream call per probed route " +
      "(cursor only: codex, deepseek and backup answer when they answer, and probing them would spend " +
      "quota or money for nothing). No subagent is started, no prompt file is read.",
    parameters: { type: "object", properties: {} },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    timeoutMs: Math.max(60_000, (cfg.probe?.timeoutMs ?? 15_000) * 8),
    async execute() {
      const keys = probe.probedRouteKeys();
      if (!keys.length) return "No route carries probe: true, so there is nothing to ask.";
      const rows = [];
      for (const key of keys) {
        // Sequential on purpose: these routes share a rate limit, and a burst is what makes one fail.
        const r = await probe.probe(key);
        rows.push({ key, model: cfg.routes[key]?.model ?? "?", cost: cfg.routes[key]?.cost ?? "?", ...r });
      }
      const width = Math.max(5, ...rows.map((r) => r.key.length));
      const lines = [`${"route".padEnd(width)}  ${"model".padEnd(22)} ${"cost".padEnd(6)} ${"alive".padEnd(5)} ${"ms".padStart(6)}  sample`];
      for (const r of rows) {
        lines.push(
          `${r.key.padEnd(width)}  ${String(r.model).padEnd(22)} ${String(r.cost).padEnd(6)} ${(r.ok ? "yes" : "NO").padEnd(5)} ${String(r.ms).padStart(6)}  ${JSON.stringify(r.sample)} (${r.reason})`,
        );
      }
      const dead = rows.filter((r) => !r.ok);
      lines.push("", dead.length ? `${dead.map((r) => r.key).join(", ")} did not answer PONG.` : "Every probed route answered PONG.");
      return lines.join("\n");
    },
  };
}

export function apply(ctx, userConfig) {
  const cfg = resolveConfig(userConfig ?? {});
  const ledger = new Ledger(expandHome(cfg.ledgerFile), cfg.budgets);
  const log = (msg) => ctx.logger.info(`[${NAME}] ${msg}`);
  const health = new RouteHealth(cfg.limits.routeCooldownMs); // shared by every jev_run in this process
  const limiter = newLimiter(cfg); // likewise: the Cursor cap holds across simultaneous runs
  const filter = new ToolFilter(cfg); // what this Harness refused to let a child filter name, learned once
  const queue = newQueue(cfg);
  // The manager seat's turn counter. One per process, like health and the limiter, so turns keep
  // alternating across every jev_run in this Harness instead of restarting at zero on each call.
  const rotation = new Map();
  // jev_watch is the read-only companion tool: it only reads the steps file, 9Router SQLite, and the ledger.
  // The cost tracker is also cheap (a single read-only DB handle), so we create it once per process.
  const watchCost = cfg.cost?.enabled !== false ? createCostTracker({ ...cfg, cost: { ...cfg.cost, dbFile: expandHome(cfg.cost.dbFile) } }, { log }) : null;
  // One probe cache per process, shared by every jev_run and by jev_probe, so a route is asked
  // once per ttlMs rather than once per child.
  const probe = cfg.probe?.enabled !== false ? createProbe({ ...cfg, probe: { ...cfg.probe, dataDir: expandHome(cfg.probe?.dataDir ?? "~/.9router") } }, { log }) : null;
  const disposers = [];

  const mount = () => {
    if (disposers.length) return;
    disposers.push(ctx.tools.register(buildTool(ctx, cfg, ledger, log, health, limiter, filter, queue, probe, rotation)));
    if (watchCost) disposers.push(ctx.tools.register(buildWatchTool(ctx, cfg, ledger, log, watchCost)));
    if (probe) disposers.push(ctx.tools.register(buildProbeTool(ctx, cfg, log, probe)));
    log(`tool "${cfg.toolName}" registered (v${version})${watchCost ? " (+ jev_watch)" : ""}${probe ? " (+ jev_probe)" : ""}`);
  };

  // The tool needs the subagent provider; mount it whenever that appears.
  ctx.on("subagent/provider-added", (provider) => {
    if (provider.name === cfg.subagentProvider) mount();
  });
  ctx.on("subagent/provider-removed", (providerName) => {
    if (providerName !== cfg.subagentProvider || !disposers.length) return;
    while (disposers.length) disposers.pop()();
  });
  if (ctx.subagents.getProvider(cfg.subagentProvider)) mount();
  else log(`subagent provider "${cfg.subagentProvider}" not registered yet; "${cfg.toolName}" will register when it appears`);
}

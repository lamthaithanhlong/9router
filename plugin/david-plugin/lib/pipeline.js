import { estimateTokens } from "./budget.js";
import { gate2Triggers, parseVerdict } from "./gates.js";
import { looksEnglish } from "./laya.js";
import { resolveRole } from "./roles.js";

// Host-independent core. `deps` carries everything that touches the outside:
//   cfg, ledger, laya            config, spend counter, Laya client
//   cost                         dollar-cost tracker (lib/cost.js); may be omitted by tests
//   steps                        step feed writer (lib/steps.js); may be omitted by tests
//   runId                        shared by every line in this run's step feed
//   spawn(route, prompt, label, role)  run one child agent, resolve to its text
//   loadPrompt(role)             role prompt text
//   getChanges(cwd), runTests(cwd, command)
//   log(msg)

async function runAgent(deps, role, message, label, opts = {}) {
  const { cfg } = deps;
  const prompt = `${deps.loadPrompt(opts.promptRole ?? role)}\n\n---\n\n${message}`;
  const inTokens = estimateTokens(prompt);
  const need = inTokens + cfg.limits.assumedOutputTokens;
  // `opts.skipRoutes` forces a role off the route it would otherwise pick — how the cross-check
  // asks a *second* reviewer instead of the same one again.
  const skip = [...(opts.skipRoutes ?? [])];
  const attempts = [];
  for (;;) {
    const res = resolveRole(role, cfg, deps.ledger, need, { skip, health: deps.health, rotation: deps.rotation });
    // Every chain entry that was refused is written down, with its reason. A route that vanishes
    // without a word is how a worker call ended up on Cursor for 290s while `deepseek`, the chain's
    // first entry, was never offered at all (2026-10-07). The owner must never have to guess.
    const reasonLines = (res.skipped ?? []).map((s) => {
      const line = `${role}: skipped ${s.key} (${s.why})`;
      deps.steps?.step(line, { run: deps.runId, role, route: s.key, skipped: true, taskUsd: deps.cost?.taskUsd() ?? 0 });
      return line;
    });
    if (res.kind === "hold") {
      const reason = skip.length ? `${role}: every route failed or is out of budget (${attempts.join("; ")})` : res.reason;
      return { status: "held", reason: reasonLines.length ? `${reason} [${reasonLines.join("; ")}]` : reason };
    }
    const { route } = res;
    deps.log(`${role} -> ${route.key}${route.via ? ` (via ${route.via}, turn ${route.turn})` : ""}${res.fellBack ? " (fallback)" : ""}${reasonLines.length ? ` (${reasonLines.length} skipped)` : ""}`);

    // Part D: ask a known-flaky route whether it answers at all, before spending a child on it.
    // The Cursor route can return HTTP 200 with no text; a child that discovers that the slow way
    // has taken 1638s to abort. One 15s probe replaces that wait, and a route that fails the probe
    // goes into the same cooldown as a route that failed for real.
    if (cfg.probe?.enabled !== false && route.probe === true && deps.probe) {
      const p = await deps.probe.probe(route.key);
      if (!p.ok) {
        deps.health?.fail(route.key);
        skip.push(route.key);
        attempts.push(`${route.key}: ${p.reason}`);
        deps.steps?.step(`probe ${route.key}: ${p.reason} - skipped`, { run: deps.runId, role, label, route: route.key });
        deps.log(`${role} on ${route.key} skipped: probe ${p.reason}`);
        continue;
      }
      deps.steps?.step(`probe ${route.key}: answered ${p.reason} in ${p.ms}ms`, { run: deps.runId, role, label, route: route.key, usd: 0, taskUsd: deps.cost?.taskUsd() ?? 0 });
    }

    // Cost caps: only money routes are refused. Free and quota routes are still measured and
    // written to the step feed, but a list price (e.g. 9Router's recorded $0.0335 for a Cursor
    // worker that is actually a free local relay) must never throttle them.
    const costOn = !!deps.cost && cfg.cost?.enabled !== false && cfg.cost?.enforce !== false && route.cost === "money";
    if (costOn) {
      const assume = deps.cost.assumeUsd(route.key);
      if (assume > cfg.cost.callUsd) {
        // Over the per-call cap: skip this route, try the next affordable one on the chain.
        skip.push(route.key);
        attempts.push(`${route.key}: cost cap $${assume.toFixed(4)} > $${cfg.cost.callUsd}`);
        deps.log(`${role} on ${route.key} skipped: cost cap $${assume.toFixed(4)} > $${cfg.cost.callUsd}`);
        continue;
      }
      if (deps.cost.taskUsd() + assume > cfg.cost.taskUsd) {
        // Over the per-task cap: stop the whole run.
        return {
          status: "held",
          reason: `cost: task budget $${cfg.cost.taskUsd} exceeded (spent $${deps.cost.taskUsd().toFixed(4)}, this call ~$${assume.toFixed(4)})`,
        };
      }
    }
    // Record the start before any expensive work, so `node watch.mjs` shows it instantly.
    deps.steps?.step(`${label} started on ${route.key}${route.via ? ` (via ${route.via})` : ""}`, { ...(route.via ? { via: route.via, turn: route.turn } : {}), run: deps.runId, role, label, route: route.key, model: route.model, usd: costOn ? deps.cost.assumeUsd(route.key) : 0, taskUsd: deps.cost?.taskUsd() ?? 0 });

    let text = "";
    let cacheInfo = null; // prompt-cache stats of this call, when the spawn reported them
    let tokensReal = null;
    let failure;
    let cancelled = false; // the caller cancelled mid-call: the call did not succeed AND did not fail on its own
    let usd = 0;
    let calls = 0;
    let upstreamAttempts = 0; // upstream rows one logical call wrote: a retry combo writes several
    let unmatched = 0; // rows in the window that could not be attributed to this route
    // Watermark: any usageHistory row written AFTER this id is this call's spend.
    const watermark = deps.cost?.snapshot?.() ?? -1;
    // Wait for a slot on this route's upstream before starting the child (queue, never refuse).
    const release = (await deps.limiter?.acquire(route.group ?? route.key)) ?? (() => {});
    const queuedMs = release.queuedMs ?? 0;
    const t0 = Date.now();
    try {
      const raw = await deps.spawn(route, prompt, label ?? role, role);
      // spawn resolves to a string (subagents, queue) or { text, tokensIn, tokensOut } (lib/api.js).
      // Real counts count only when both are finite and nonzero: { 0, 0 } means the upstream sent
      // no usage, and then the estimate path still applies. Anything else is no content.
      if (typeof raw === "string") {
        text = raw;
      } else if (raw && typeof raw.text === "string") {
        text = raw.text;
        if (raw.cache && Number.isFinite(raw.cache.calls)) cacheInfo = raw.cache;
        if (Number.isFinite(raw.tokensIn) && Number.isFinite(raw.tokensOut) && raw.tokensIn + raw.tokensOut > 0) {
          tokensReal = { tokensIn: raw.tokensIn, tokensOut: raw.tokensOut };
        }
      } else {
        throw new Error("the route returned no content");
      }
      // A route that answers with nothing has not worked: an upstream that returns an empty 200 (Cursor through
      // 9Router does) would otherwise count as a success and no fallback would ever run.
      if (text.trim() === "") throw new Error("the route returned no content");
      deps.health?.ok(route.key);
    } catch (err) {
      failure = err;
      if (deps.aborted?.()) {
        // The caller cancelled: do not try another route. `failure` must still be set, or the trace
        // below records this call as status "ok" with 0 output tokens - which is how two cancelled
        // runs (431 s and 258 s, nothing returned) showed a worker "ok" in the run log.
        cancelled = true;
        throw err;
      }
    } finally {
      release();
      // True up the cost from 9Router's log: the real USD per call lives in usageHistory, not in
      // the child's reply. Even when the call failed, a row was written.
      if (deps.cost && watermark >= 0) {
        try {
          const r = await deps.cost.reconcile(watermark, { routeKey: route.key, usage: route.usage, provider: route.provider, model: route.model });
          usd = r?.usd ?? 0;
          calls = r?.calls ?? 0;
          upstreamAttempts = calls;
          unmatched = r?.unmatched ?? 0;
          // ONLY a route that costs real money feeds the task wallet. A free or quota route still
          // reports the list price 9Router wrote (the owner must see it), but that number is fiction:
          // charging it once put a $0.1097 Codex "cost" over the $0.10 task cap, which knocked the run
          // off deepseek - the only route that costs real money - onto Cursor, where it hung 627s and
          // produced nothing. Measured 2026-10-07 on this machine.
          if (route.cost === "money") deps.cost.chargeTaskUsd(usd);
          if (unmatched > 0) {
            deps.steps?.step(`cost: ${unmatched} row(s) in the window did not match ${route.key}; charged $0`, { run: deps.runId, role, label, route: route.key, usd: 0, taskUsd: deps.cost.taskUsd() });
          }
        } catch { /* the tracker already logs once; the run continues */ }
      }
      // A child that failed still consumed its input.
      deps.ledger.charge(route.key, tokensReal ? tokensReal.tokensIn + tokensReal.tokensOut : inTokens + estimateTokens(text));
      deps.trace.push({
        role,
        label: label ?? role,
        key: route.key,
        provider: route.provider,
        model: route.model,
        fellBack: res.fellBack,
        backup: route.backup === true,
        status: cancelled ? "cancelled" : failure ? "error" : "ok",
        ...(failure ? { error: String(failure.message ?? failure).slice(0, 300) } : {}),
        ms: Date.now() - t0,
        ...(queuedMs > 500 ? { queuedMs } : {}),
        tokensIn: tokensReal ? tokensReal.tokensIn : inTokens,
        tokensOut: tokensReal ? tokensReal.tokensOut : estimateTokens(text),
        ...(calls > 0 ? { usd } : {}),
        ...(upstreamAttempts > 1 ? { attempts: upstreamAttempts } : {}),
        ...(cacheInfo ? { cache: cacheInfo } : {}),
      });
      // A provider that answers many calls without ever hitting its cache is costing full price for every token it re-reads
      // (seen 2026-10-07: three sessions at 0% on a reseller gateway while its other sessions hit 97-99%). Say so in the report.
      const miss = cacheMiss(cacheInfo);
      if (miss && deps.notes && !deps.notes.some((n) => n.startsWith(`cache: ${route.key} `))) {
        const silent = cacheInfo.reported === 0; // not one call carried a cache field: the provider does not report it (or does not cache)
        deps.notes.push(`cache: ${route.key} (${route.provider}/${route.model}) answered ${cacheInfo.calls} calls with ${miss.pct}% prompt-cache hits ` +
          `(${cacheInfo.uncached} tokens at full price): ${silent ? "that provider reports no cache tokens, so it is not caching (or not saying)" : "that provider is not caching this session"}`);
      }
      // Say it once, then act on it: a watched route that does not cache is skipped for a while, so the next calls go to a route that does.
      const demoteMs = deps.cfg?.limits?.cacheDemoteMs ?? 0;
      if (miss && demoteMs > 0 && (deps.cfg?.limits?.cacheWatch ?? []).includes(route.key) && deps.health?.demote && !deps.health.cooling(route.key)) {
        deps.health.demote(route.key, demoteMs);
        deps.log(`${role} on ${route.key}: no prompt cache (${miss.pct}% of ${cacheInfo.calls} calls); skipping it for ${Math.round(demoteMs / 60000)} min`);
        deps.notes?.push(`cache: ${route.key} skipped for ${Math.round(demoteMs / 60000)} min while another route can take the work`);
      }
      // The step feed is the owner's free live view: every call has a start line and a done line.
      deps.steps?.step(`${label} ${cancelled ? "cancelled after " : failure ? "failed in " : "done in "}${((Date.now() - t0) / 1000).toFixed(1)}s, $${usd.toFixed(4)}${upstreamAttempts > 1 ? ` (${upstreamAttempts} upstream attempts)` : ""}${failure ? ` (${String(failure.message ?? failure).slice(0, 80)})` : ""}`, { run: deps.runId, role, label, route: route.key, model: route.model, usd, taskUsd: deps.cost?.taskUsd() ?? 0, ...(failure ? { status: "error" } : {}) });
    }
    if (!failure) {
      if (route.backup && !deps.notes.some((n) => n.startsWith(`${role} ran on the BACKUP`))) {
        deps.notes.push(`${role} ran on the BACKUP route (${route.provider}/${route.model}): expect lower quality`);
      }
      return { status: "ok", text, route };
    }
    deps.health?.fail(route.key);
    skip.push(route.key);
    attempts.push(`${route.key}: ${String(failure.message ?? failure).slice(0, 100)}`);
    deps.log(`${role} on ${route.key} failed (${attempts.at(-1)}); trying the next route`);
  }
}

// An investigation: one read-only seat answers a question and the ANSWER is the product. There is no git
// repository to diff, no tests, no review - david_run cannot do this (it grades a diff, and throws when the folder
// is not a repository), so a head agent that wanted to delegate a search had nowhere to send it. It runs on the
// researcher chain (the manager seat, then backup), which has no write/edit/bash tools, with the "ask" prompt.
export const ASK_WORDS = { min: 50, max: 1500, dflt: 400 };

export async function runAsk(deps, input) {
  const notes = [];
  deps.notes = notes;
  const words = Math.min(ASK_WORDS.max, Math.max(ASK_WORDS.min, Math.round(Number(input.words)) || ASK_WORDS.dflt));
  const message =
    `# QUESTION\n${input.task}\n\n` +
    `Look in ${input.cwd}. Your shell does NOT start there: use absolute paths.\n` +
    `Word limit for your reply: ${words}.`;
  const r = await runAgent(deps, "researcher", message, "ask", { promptRole: "ask" });
  if (r.status === "held") return notes.push(r.reason), { status: "awaiting_human", answer: "", notes, trace: deps.trace };
  return { status: "ok", answer: r.text.trim(), notes, trace: deps.trace };
}

export function formatAnswer(outcome, version, cost, uiUrl = null) {
  const lines = [`david_ask: ${outcome.status}`];
  if (uiUrl) lines.push("", `Live: ${uiUrl}`);
  lines.push("", outcome.answer || "(no answer)");
  // the "not called" line of david_run's trace is noise here: there is only ever one stage
  const who = formatTrace(outcome.trace).filter((l) => !l.startsWith("- not called"));
  if (who.length) lines.push("", "Who ran:", ...who);
  if (outcome.notes.length) lines.push("", "Notes:", ...outcome.notes.map((n) => `- ${n}`));
  if (cost) lines.push("", `Cost: $${cost.thisTask.toFixed(4)} this task`);
  if (version) lines.push("", `Plugin: david plugin ${version}`);
  return lines.join("\n");
}

// Prompt-cache hit rate of one call's stats, or null when there is nothing to say. `miss` only when it is clearly not caching.
export function cacheStats(c) {
  if (!c || !(c.calls > 0)) return null;
  const total = (c.uncached || 0) + (c.cached || 0);
  return total > 0 ? { pct: Math.round(((c.cached || 0) / total) * 100), total } : null;
}
const cacheMiss = (c) => {
  const s = cacheStats(c);
  return s && c.calls >= 3 && s.pct < 20 ? s : null;
};

// The plan goes first so every call shares one prefix and the cache hits.
const withPlan = (plan, body) => (plan ? `# PLAN\n${plan}\n\n${body}` : body);

function digest(text, words) {
  const w = text.trim().split(/\s+/);
  return w.length <= words ? text.trim() : `${w.slice(0, words).join(" ")} [digest cut]`;
}

async function askLaya(deps, id, state, instructions) {
  const t0 = Date.now();
  // Metered: the hosted Jev is charged per input token, so the daily cap must be
  // checked BEFORE the call, and the real usage charged after it.
  const estimate = estimateTokens(state) + 128;
  const cloudAllowed = !deps.ledger?.canSpend || deps.ledger.canSpend("laya", estimate, "laya");
  let usage = null;
  const p = await deps.laya.noul(id, state, instructions, (u) => { usage = u; }, { cloud: cloudAllowed });
  // Only the hosted endpoint consumes the daily question quota; the local engine is
  // free and unlimited, so a fallback answer must not be charged.
  const charged = usage?.source === "cloud";
  if (charged) deps.ledger?.charge?.("laya", usage.inputTokens ?? 0);
  deps.trace.push({
    role: "laya", label: id, key: "laya", provider: "laya", model: "systemone",
    status: p === null ? "unavailable" : "ok", detail: p, ms: Date.now() - t0,
    ...(charged && Number.isFinite(usage?.inputTokens) ? { tokensIn: usage.inputTokens } : {}),
    ...(usage?.source ? { source: usage.source } : {}),
    ...(cloudAllowed ? {} : { detail2: "daily question quota spent: answered locally" }),
  });
  return p;
}

async function decidePlan(deps, input, notes) {
  if (input.plan === "yes") return true;
  if (input.plan === "no") return false;
  const heuristic = () => input.task.length > deps.cfg.heuristics.planChars || input.tasks.length > 1;
  const lc = deps.cfg.laya;
  if (!lc.planEnabled) return heuristic();
  if (lc.englishOnly && !looksEnglish(input.task)) {
    notes.push("task is not English: laya skipped, plan decided by length");
    return heuristic();
  }
  const p = await askLaya(
    deps,
    "needs_plan",
    `Task: ${input.task}`,
    "Does this task need a written plan before any code is changed (several files, design decisions, unclear approach)?",
  );
  if (p === null) {
    notes.push("laya unavailable: plan decided by length");
    return heuristic();
  }
  notes.push(`laya needs_plan=${p}`);
  return p >= deps.cfg.laya.planThreshold;
}

// Gate 1: tests, with bounded fix rounds. Free models only.
async function verify(deps, input, plan, state, notes) {
  let streak = 0;
  for (let round = 0; ; round++) {
    const changes = await deps.getChanges(input.cwd);
    const tests = await deps.runTests(input.cwd, input.testCommand);
    if (round === 0 && !tests.ran) notes.push("no test command: green means untested");
    if (tests.passed) return { ok: true, changes };
    streak++;
    state.maxStreak = Math.max(state.maxStreak, streak);
    if (round >= deps.cfg.limits.maxFixRounds) {
      notes.push(`tests still red after ${round} fix rounds: ${tests.summary.slice(-500)}`);
      return { ok: false };
    }
    const fix = await runAgent(deps, "worker", withPlan(plan, `# FIX\nWork in ${input.cwd}. Tests failed:\n${tests.summary}`), "worker-fix");
    if (fix.status === "held") {
      notes.push(fix.reason);
      return { ok: false };
    }
  }
}

export async function runPipeline(deps, input) {
  const { cfg } = deps;
  deps.trace = deps.trace ?? [];
  const notes = [];
  deps.notes = notes;
  let strongReview = false; // a review approved by a primary (non-backup) reviewer
  let plan = "";
  let triggers = [];
  const end = (status) => ({ status, notes, plan, triggers, trace: deps.trace });
  const scope = input.allowedPaths.length ? input.allowedPaths.join("\n") : "(not restricted)";
  // Measured: a child starts in the head agent's directory, not in cwd.
  const where = `Work in ${input.cwd}. Your shell does NOT start there: run every command as \`cd ${input.cwd} && <command>\` and use absolute paths for files.`;

  // 1. Plan: once, by the strong model, only when needed.
  if (await decidePlan(deps, input, notes)) {
    const p = await runAgent(deps, "planner", `# TASK\n${input.task}\n\n${where}`, "planner");
    if (p.status === "held") return notes.push(p.reason), end("awaiting_human");
    plan = p.text.trim();
  }

  // 2. Researchers first, so their digest reaches the workers.
  const research = await Promise.allSettled(
    input.research.map((q, i) => runAgent(deps, "researcher", withPlan(plan, `# QUESTION\n${q}`), `researcher-${i + 1}`)),
  );
  if (deps.aborted?.()) throw new Error("run cancelled");
  const findings = [];
  for (const r of research) {
    if (r.status === "rejected") notes.push(`researcher failed: ${r.reason?.message ?? r.reason}`);
    else if (r.value.status === "held") notes.push(r.value.reason);
    else findings.push(digest(r.value.text, cfg.limits.researchDigestWords));
  }

  // 3. Workers, in parallel.
  const work = await Promise.allSettled(
    input.tasks.map((t, i) =>
      runAgent(
        deps,
        "worker",
        withPlan(plan, `# TASK\n${t}\n\n${where}\n\n# ALLOWED PATHS\n${scope}` + (findings.length ? `\n\n# RESEARCH\n${findings.join("\n---\n")}` : "")),
        `worker-${i + 1}`,
      ),
    ),
  );
  if (deps.aborted?.()) throw new Error("run cancelled");
  if (!work.some((w) => w.status === "fulfilled" && w.value.status === "ok")) {
    notes.push("no worker produced a result");
    for (const w of work) {
      if (w.status === "rejected") notes.push(String(w.reason?.message ?? w.reason));
      else if (w.value.status === "held") notes.push(w.value.reason);
    }
    return end("awaiting_human");
  }

  // 4. Gate 1.
  const state = { maxStreak: 0 };
  let v = await verify(deps, input, plan, state, notes);
  if (!v.ok) return end("failed");
  // A worker that was blocked, or declined, leaves exactly what a worker that finished a no-op leaves: an empty diff, and
  // the report said "done" (seen 2026-10-07: a Codex worker answered "Blocked: ... must go through david_run" and the run was
  // green). A change tool whose workers changed nothing is not done: hand it back with what the workers said.
  if (v.changes.files.length === 0) {
    const said = work.flatMap((w) => (w.status === "fulfilled" && w.value.status === "ok" ? [digest(w.value.text, 60)] : []));
    notes.push(`no files changed: the workers produced no diff${said.length ? `. They said: ${said.join(" | ")}` : ""}`);
    return end("awaiting_human");
  }

  // 5. Gate 2: the paid reviewer. Rules first; Laya may only add a reason.
  triggers = gate2Triggers({ files: v.changes.files, allowedPaths: input.allowedPaths, testFailStreak: state.maxStreak }, cfg.gate2);
  if (triggers.length === 0 && cfg.laya.reviewEnabled) {
    const files = v.changes.files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join("\n");
    const p = await askLaya(
      deps,
      "needs_review",
      `Task: ${input.task}\nChanged files:\n${files}\n\n${v.changes.diff.slice(0, 3000)}`,
      "Could this change break existing behaviour or security in a way that deserves an independent review?",
    );
    if (p !== null && p >= cfg.laya.reviewThreshold) triggers.push(`laya review risk ${p}`);
    else if (p !== null) notes.push(`laya needs_review=${p}: no review`);
  }
  if (triggers.length > 0) {
    for (let round = 1; ; round++) {
      const r = await runAgent(deps, "reviewer", withPlan(plan, `# WHY YOU WERE CALLED\n${triggers.join("\n")}\n\n# DIFF\n${v.changes.diff}`), "reviewer");
      if (r.status === "held") return notes.push(r.reason), end("awaiting_human");
      const verdict = parseVerdict(r.text);
      if (verdict.verdict === "approve") {
        if (!r.route.backup) strongReview = true;
        // Part D: second opinions before the diff is accepted. The owner asked for codex and
        // deepseek to both read the change and report; a split verdict goes to a person instead
        // of being settled by whichever reviewer happened to run first.
        const opinions = [{ key: r.route.key, verdict: "approve", issues: [] }];
        const crossCheck = Array.isArray(cfg.review?.crossCheck) ? cfg.review.crossCheck : [];
        for (const want of crossCheck) {
          if (want === r.route.key) continue;
          const second = await runAgent(
            deps,
            "reviewer",
            withPlan(plan, `# SECOND OPINION\nA first reviewer approved this diff. Give your own verdict.\n\n${triggers.join("\n")}\n\n# DIFF\n${v.changes.diff}`),
            `reviewer-${opinions.length + 1}`,
            { skipRoutes: [r.route.key] },
          );
          if (second.status === "held") {
            // Could not be obtained is NOT a disagreement: report it as unavailable and move on.
            opinions.push({ key: want, verdict: "unavailable", issues: [second.reason] });
            continue;
          }
          const sv = parseVerdict(second.text);
          opinions.push({ key: second.route.key, verdict: sv.verdict, issues: sv.issues });
          if (sv.verdict === "approve" && !second.route.backup) strongReview = true;
        }
        if (opinions.length > 1) {
          const line = opinions.map((o) => `${o.key} -> ${o.verdict}`).join(" | ");
          deps.steps?.step(`review: ${line}`, { run: deps.runId, role: "reviewer", label: "reviewer", route: r.route.key, usd: 0, taskUsd: deps.cost?.taskUsd() ?? 0 });
          notes.push(`review cross-check: ${line}`);
          const split = opinions.some((o) => o.verdict !== "approve" && o.verdict !== "unavailable");
          if (split && cfg.review?.onDisagree === "awaiting_human") {
            notes.push("reviewers disagreed: a person must decide (review.onDisagree = awaiting_human)");
            return end("awaiting_human");
          }
        }
        break;
      }
      notes.push(`review round ${round}: ${verdict.issues.join("; ")}`);
      if (round >= cfg.limits.maxReviewRounds) return end("awaiting_human");
      const fix = await runAgent(deps, "worker", withPlan(plan, `# FIX\n${where}\nReviewer issues:\n${verdict.issues.join("\n")}`), "worker-fix");
      if (fix.status === "held") return notes.push(fix.reason), end("awaiting_human");
      v = await verify(deps, input, plan, state, notes);
      if (!v.ok) return end("failed");
    }
  }

  // 6. Gate 3: Codex before merge, only for risky diffs or when forced.
  if (triggers.length > 0 || input.finalReview) {
    const f = await runAgent(deps, "final_reviewer", withPlan(plan, `# DIFF\n${v.changes.diff}`), "final-reviewer");
    if (f.status === "held") {
      notes.push(`gate 3 skipped: ${f.reason}`);
    } else {
      const verdict = parseVerdict(f.text);
      if (verdict.verdict !== "approve") {
        notes.push(`final review: ${verdict.issues.join("; ")}`);
        return end("awaiting_human");
      }
      if (!f.route.backup) strongReview = true;
    }
  }

  // A risky diff that only backup (free) reviewers approved needs a person, unless the config accepts that.
  if (triggers.length > 0 && !strongReview && !cfg.backupPolicy.reviewIsFinal) {
    notes.push("the risky diff was approved only by backup (free) reviewers: a person must sign off (backupPolicy.reviewIsFinal is false)");
    return end("awaiting_human");
  }

  return end("done");
}

const AGENT_ROLES = ["planner", "researcher", "worker", "reviewer", "final_reviewer"];

// "who ran": one line per agent or Laya call, then the roles that never ran.
export function formatTrace(trace = []) {
  const lines = [];
  for (const e of trace) {
    if (e.role === "laya") {
      lines.push(`- laya ${e.label}: ${e.status === "ok" ? `p=${e.detail}` : "unavailable"} (${(e.ms / 1000).toFixed(2)}s)`);
    } else {
      const fb = e.fellBack ? ", fallback" : "";
      const err = e.status === "error" ? ", FAILED" : e.status === "cancelled" ? ", CANCELLED" : "";
      const why = (e.status === "error" || e.status === "cancelled") && e.error ? ` (${e.error.replace(/\s+/g, " ").slice(0, 90)})` : "";
      lines.push(`- ${e.label} -> ${e.provider}/${e.model} [${e.key}${fb}${err}] ${(e.ms / 1000).toFixed(1)}s${e.queuedMs ? ` (queued ${(e.queuedMs / 1000).toFixed(1)}s)` : ""} ~${e.tokensIn} in / ~${e.tokensOut} out tok${cacheStats(e.cache) ? `, cache ${cacheStats(e.cache).pct}% of ${e.cache.calls} calls` : ""}${why}`);
    }
  }
  const ran = new Set(trace.map((e) => e.role));
  const idle = AGENT_ROLES.filter((r) => !ran.has(r));
  if (idle.length) lines.push(`- not called: ${idle.join(", ")}`);
  return lines;
}

export function formatReport(outcome, changes, version, cost, uiUrl = null) {
  const lines = [`david_run: ${outcome.status}`];
  // The live view, first line after the status: the owner reads this in the chat and follows the
  // run in a browser. Free (it only reads files), so there is no reason to hide it.
  if (uiUrl) lines.push("", `Live: ${uiUrl}  - mo link de xem tung con dang chay (chi doc file, khong ton call)`);
  if (outcome.trace) lines.push("", "Who ran:", ...formatTrace(outcome.trace));
  if (outcome.plan) lines.push("", "Plan:", outcome.plan);
  if (outcome.triggers.length) lines.push("", `Review triggers: ${outcome.triggers.join("; ")}`);
  if (outcome.notes.length) lines.push("", "Notes:", ...outcome.notes.map((n) => `- ${n}`));
  if (cost) {
    // Cost section: the real per-task spend, today's via-9Router total, and the caps that gated the run.
    const task = `$${cost.thisTask.toFixed(4)} this task (task cap $${cost.taskCap}, call cap $${cost.callCap})`;
    const day = cost.day ? `$${cost.day.usd.toFixed(4)} today via 9Router, ${cost.day.requests} calls` : "today: n/a";
    lines.push("", `Cost: ${task}`, `      ${day}`);
  }
  if (changes?.files?.length) lines.push("", "Changed files:", ...changes.files.map((f) => `- ${f.path} (+${f.added} -${f.removed})`));
  if (outcome.status === "awaiting_human") lines.push("", "A human decision is needed; nothing was merged.");
  if (version) lines.push("", `Plugin: david plugin ${version}`);
  return lines.join("\n");
}

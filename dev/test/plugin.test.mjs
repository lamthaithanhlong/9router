import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, buildAskTool, buildTool, inject, name } from "../../plugin/david-plugin/index.js";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { resolveConfig } from "../../plugin/david-plugin/lib/config.js";

// A stand-in for the slice of the Cordis context the plugin touches.
function fakeCtx({ withProvider = true, results = {} } = {}) {
  const handlers = new Map();
  const registered = [];
  const starts = [];
  let provider = withProvider ? { name: "spawn" } : undefined;
  const ctx = {
    logger: { info() {} },
    on: (ev, fn) => handlers.set(ev, fn),
    tools: { register: (tool) => (registered.push(tool), () => registered.splice(registered.indexOf(tool), 1)) },
    subagents: {
      getProvider: () => provider,
      resolveMaxDepth: () => 1,
      async start(providerName, req) {
        starts.push({ providerName, req });
        const r = results[req.agentOptions.model] ?? { stopReason: "completed", text: "ok" };
        return {
          result: Promise.resolve({ stopReason: r.stopReason, diagnostic: r.diagnostic, output: [{ type: "text", text: r.text ?? "" }] }),
          dispose() {},
        };
      },
    },
  };
  return { ctx, handlers, registered, starts, setProvider: (p) => (provider = p) };
}

test("module contract: name, inject, apply", () => {
  assert.equal(name, "david-plugin");
  assert.deepEqual(inject, ["tools", "subagents"]);
  assert.equal(typeof apply, "function");
});

test("apply: registers david_run, david_ask, david_watch and david_probe when the spawn provider is present", () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  assert.deepEqual(f.registered.map((t) => t.name), ["david_run", "david_ask", "david_watch", "david_probe"]);
});

test("apply: waits for the provider, mounts when it appears, unmounts when it goes", () => {
  const f = fakeCtx({ withProvider: false });
  apply(f.ctx, {});
  assert.equal(f.registered.length, 0);
  f.handlers.get("subagent/provider-added")({ name: "fork" });
  assert.equal(f.registered.length, 0); // some other provider
  f.handlers.get("subagent/provider-added")({ name: "spawn" });
  assert.deepEqual(f.registered.map((t) => t.name), ["david_run", "david_ask", "david_watch", "david_probe"]);
  f.handlers.get("subagent/provider-added")({ name: "spawn" });
  assert.equal(f.registered.length, 4); // not mounted twice
  f.handlers.get("subagent/provider-removed")("spawn");
  assert.equal(f.registered.length, 0);
});

test("apply: david_watch is absent when cost.enabled is false; david_probe does not depend on cost", () => {
  const f = fakeCtx();
  apply(f.ctx, { cost: { enabled: false } });
  assert.deepEqual(f.registered.map((t) => t.name), ["david_run", "david_ask", "david_probe"]);
});

test("apply: david_probe is absent when probe.enabled is false, david_watch still mounts", () => {
  const f = fakeCtx();
  apply(f.ctx, { probe: { enabled: false } });
  assert.deepEqual(f.registered.map((t) => t.name), ["david_run", "david_ask", "david_watch"]);
});

test("tool definition: schema shape the Harness expects", () => {
  const cfg = resolveConfig();
  const tool = buildTool(fakeCtx().ctx, cfg, new Ledger(join(mkdtempSync(join(tmpdir(), "david-")), "l.json"), cfg.budgets));
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["task", "cwd"]);
  assert.ok(!("model" in tool.parameters.properties) && !("provider" in tool.parameters.properties));
  assert.equal(tool.output.schema.type, "string");
  assert.deepEqual(tool.output.render({}, "hello"), [{ type: "text", text: "hello" }]);
  assert.ok(tool.timeoutMs > 0);
});

function runTool(f, args, cfgOver = {}) {
  const cfg = resolveConfig({ laya: { enabled: false }, ledgerFile: "unused", ...cfgOver });
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "david-")), "l.json"), cfg.budgets);
  const tool = buildTool(f.ctx, cfg, ledger);
  const exec = { agent: { id: "head" }, signal: new AbortController().signal };
  return tool.execute(args, exec);
}

test("execute: a task reaches Cursor through the spawn provider with the route and parent set", async () => {
  const f = fakeCtx();
  // not a git repo, so the diff step fails: that is fine, only the first child call matters here
  await runTool(f, { task: "t", cwd: "/definitely/not/a/repo", plan: "no" }).catch(() => {});
  assert.equal(f.starts.length, 1);
  const { providerName, req } = f.starts[0];
  assert.equal(providerName, "spawn");
  assert.deepEqual(req.agentOptions, { provider: "router9", model: "cursor-workers" });
  assert.deepEqual(req.parent, { id: "head" });
  assert.equal(req.maxDepth, 1);
  assert.equal(req.prompt[0].type, "text");
  assert.match(req.prompt[0].text, /ROLE: worker/);
  assert.match(req.prompt[0].text, /Work in \/definitely\/not\/a\/repo/);
});

test("execute: when every route's child ends abnormally the report carries the diagnostic", async () => {
  const bad = { stopReason: "error", diagnostic: "boom", text: "half" };
  const f = fakeCtx({ results: { "cursor-workers": bad, "backup-free": bad } });
  const out = await runTool(f, { task: "t", cwd: "/x", plan: "no" });
  assert.match(out, /awaiting_human/);
  assert.match(out, /ended with error: boom/);
  assert.deepEqual(f.starts.map((s) => s.req.agentOptions.model), ["cursor-workers", "backup-free"]);
});

test("execute: a failing primary worker route is followed by the backup route, with the same tool filter", async () => {
  const f = fakeCtx({ results: { "cursor-workers": { stopReason: "error", diagnostic: "quota", text: "" } } });
  await runTool(f, { task: "t", cwd: "/definitely/not/a/repo", plan: "no" }).catch(() => {});
  assert.deepEqual(f.starts.map((s) => s.req.agentOptions.model), ["cursor-workers", "backup-free"]);
  assert.deepEqual(f.starts[1].req.toolFilter, f.starts[0].req.toolFilter);
});
test("execute: a route that fails its probe is skipped before any child is started on it", async () => {
  const f = fakeCtx();
  const cfg = resolveConfig({ laya: { enabled: false }, ledgerFile: "unused" });
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "david-")), "l.json"), cfg.budgets);
  const asked = [];
  const probe = {
    probedRouteKeys: () => ["cursor"],
    probe: async (key) => {
      asked.push(key);
      return { ok: false, ms: 5, chars: 0, sample: "", reason: "empty reply (HTTP 200, 0 chars)", at: Date.now() };
    },
  };
  // buildTool(ctx, cfg, ledger, log, health, limiter, filter, queue, probe)
  const tool = buildTool(f.ctx, cfg, ledger, () => {}, undefined, undefined, undefined, undefined, probe);
  const exec = { agent: { id: "head" }, signal: new AbortController().signal };
  await tool.execute({ task: "t", cwd: "/definitely/not/a/repo", plan: "no" }, exec).catch(() => {});
  assert.deepEqual(asked, ["cursor"], "the probed route was asked before a child was committed");
  assert.ok(f.starts.length >= 1, "the pipeline still ran on the route after it");
  assert.equal(f.starts[0].req.agentOptions.model, "backup-free", "the dead route never got a child");
});

test("execute: refuses to run without a calling agent", async () => {
  const f = fakeCtx();
  const cfg = resolveConfig();
  const tool = buildTool(f.ctx, cfg, new Ledger(join(mkdtempSync(join(tmpdir(), "david-")), "l.json"), cfg.budgets));
  await assert.rejects(tool.execute({ task: "t", cwd: "/x" }, { signal: new AbortController().signal }), /requires a calling agent/);
});

test("apply: history in the old jev-* files is copied to david-* when the plugin starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "david-"));
  writeFileSync(join(dir, "jev-runs.jsonl"), '{"old":1}\n');
  writeFileSync(join(dir, "jev-ledger.json"), '{"day":"d","used":{}}');
  const f = fakeCtx();
  apply(f.ctx, { runLog: join(dir, "david-runs.jsonl"), ledgerFile: join(dir, "david-ledger.json"), stepsFile: join(dir, "david-steps.jsonl"), dashboard: { enabled: false } });
  assert.equal(readFileSync(join(dir, "david-runs.jsonl"), "utf8"), '{"old":1}\n');
  assert.equal(readFileSync(join(dir, "david-ledger.json"), "utf8"), '{"day":"d","used":{}}');
  assert.ok(existsSync(join(dir, "jev-runs.jsonl")), "the original stays");
});

function askRig(results = {}, cfgOver = {}) {
  const f = fakeCtx({ results });
  const dir = mkdtempSync(join(tmpdir(), "david-"));
  const cfg = resolveConfig({ laya: { enabled: false }, ledgerFile: "unused", stepsFile: join(dir, "s.jsonl"), runLog: join(dir, "r.jsonl"), ...cfgOver });
  const runTool = buildTool(f.ctx, cfg, new Ledger(join(dir, "l.json"), cfg.budgets));
  return { f, dir, cfg, runTool, ask: buildAskTool(runTool, cfg), exec: { agent: { id: "head" }, signal: new AbortController().signal } };
}
const ANSWER = { stopReason: "completed", text: "It is in /x/a.js:3 (the retry cap is 5)." };

test("david_ask: a question is answered by a read-only investigator, in a folder that is not a git repository", async () => {
  const r = askRig({ "codex-head": ANSWER, "deepseek-v4.1-flash": ANSWER });
  const out = await r.ask.execute({ question: "where is the retry cap set?", cwd: "/definitely/not/a/repo" }, r.exec);
  assert.match(out, /^david_ask: ok/);
  assert.match(out, /It is in \/x\/a\.js:3/, "the answer itself is the product");
  assert.match(out, /Who ran:/);
  assert.ok(!/not called/.test(out), "david_run's list of idle roles is noise for a single stage");
  assert.match(out, /Plugin: david plugin /);
  assert.equal(r.f.starts.length, 1, "one child, no git diff, no tests, no review");
  const { req } = r.f.starts[0];
  const text = req.prompt[0].text;
  assert.match(text, /ROLE: investigator/, "the ask prompt, not the GitHub-digest researcher one");
  assert.match(text, /# QUESTION\nwhere is the retry cap set\?/);
  assert.match(text, /Look in \/definitely\/not\/a\/repo/);
  assert.match(text, /Word limit for your reply: 400/);
  for (const t of ["write", "edit", "david_ask", "david_run", "subagent"]) assert.ok(req.toolFilter.deny.includes(t), `an investigator must not get ${t}`);
  // it lands in the same feed and run log as david_run, so the dashboard shows it
  const steps = readFileSync(r.cfg.stepsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(steps.some((x) => x.text === "run started") && steps.some((x) => /^run done/.test(x.text)));
  assert.ok(steps.some((x) => x.label === "ask" && x.role === "researcher"));
  const run = JSON.parse(readFileSync(r.cfg.runLog, "utf8").trim().split("\n").at(-1));
  assert.equal(run.status, "ok");
  assert.equal(run.task, "where is the retry cap set?");
  assert.equal(run.cwd, "/definitely/not/a/repo");
});

test("david_ask: without a cwd it looks in the home directory, and max_words is passed on within its limits", async () => {
  const r = askRig({ "codex-head": ANSWER, "deepseek-v4.1-flash": ANSWER });
  await r.ask.execute({ question: "q", max_words: 99999 }, r.exec);
  assert.match(r.f.starts[0].req.prompt[0].text, new RegExp(`Look in ${homedir().replace(/[/.]/g, "\\$&")}`));
  assert.match(r.f.starts[0].req.prompt[0].text, /Word limit for your reply: 1500/);
});

test("david_ask: refuses an empty question and a call with no agent; david_run does not expose its ask mode", async () => {
  const r = askRig();
  await assert.rejects(r.ask.execute({ question: "   " }, r.exec), /needs a question/);
  await assert.rejects(r.ask.execute({ question: "q" }, { signal: new AbortController().signal }), /requires a calling agent/);
  assert.ok(!("_mode" in r.runTool.parameters.properties), "a model must not be able to switch david_run into ask mode");
  assert.deepEqual(r.ask.parameters.required, ["question"]);
  assert.ok(r.ask.timeoutMs > 0 && r.ask.output.schema.type === "string");
});

import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, buildTool, inject, name } from "../../plugin/david-plugin/index.js";
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

test("apply: registers jev_run, jev_watch and jev_probe when the spawn provider is present", () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  assert.deepEqual(f.registered.map((t) => t.name), ["jev_run", "jev_watch", "jev_probe"]);
});

test("apply: waits for the provider, mounts when it appears, unmounts when it goes", () => {
  const f = fakeCtx({ withProvider: false });
  apply(f.ctx, {});
  assert.equal(f.registered.length, 0);
  f.handlers.get("subagent/provider-added")({ name: "fork" });
  assert.equal(f.registered.length, 0); // some other provider
  f.handlers.get("subagent/provider-added")({ name: "spawn" });
  assert.deepEqual(f.registered.map((t) => t.name), ["jev_run", "jev_watch", "jev_probe"]);
  f.handlers.get("subagent/provider-added")({ name: "spawn" });
  assert.equal(f.registered.length, 3); // not mounted twice
  f.handlers.get("subagent/provider-removed")("spawn");
  assert.equal(f.registered.length, 0);
});

test("apply: jev_watch is absent when cost.enabled is false; jev_probe does not depend on cost", () => {
  const f = fakeCtx();
  apply(f.ctx, { cost: { enabled: false } });
  assert.deepEqual(f.registered.map((t) => t.name), ["jev_run", "jev_probe"]);
});

test("apply: jev_probe is absent when probe.enabled is false, jev_watch still mounts", () => {
  const f = fakeCtx();
  apply(f.ctx, { probe: { enabled: false } });
  assert.deepEqual(f.registered.map((t) => t.name), ["jev_run", "jev_watch"]);
});

test("tool definition: schema shape the Harness expects", () => {
  const cfg = resolveConfig();
  const tool = buildTool(fakeCtx().ctx, cfg, new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), cfg.budgets));
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["task", "cwd"]);
  assert.ok(!("model" in tool.parameters.properties) && !("provider" in tool.parameters.properties));
  assert.equal(tool.output.schema.type, "string");
  assert.deepEqual(tool.output.render({}, "hello"), [{ type: "text", text: "hello" }]);
  assert.ok(tool.timeoutMs > 0);
});

function runTool(f, args, cfgOver = {}) {
  const cfg = resolveConfig({ laya: { enabled: false }, ledgerFile: "unused", ...cfgOver });
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), cfg.budgets);
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
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), cfg.budgets);
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
  const tool = buildTool(f.ctx, cfg, new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), cfg.budgets));
  await assert.rejects(tool.execute({ task: "t", cwd: "/x" }, { signal: new AbortController().signal }), /requires a calling agent/);
});

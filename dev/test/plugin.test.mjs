import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, buildTool, inject, name } from "../../plugin/jev-orchestrator/index.js";
import { Ledger } from "../../plugin/jev-orchestrator/lib/budget.js";
import { resolveConfig } from "../../plugin/jev-orchestrator/lib/config.js";

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
  assert.equal(name, "jev-orchestrator");
  assert.deepEqual(inject, ["tools", "subagents"]);
  assert.equal(typeof apply, "function");
});

test("apply: registers jev_run when the spawn provider is present", () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  assert.deepEqual(f.registered.map((t) => t.name), ["jev_run", "jev_watch"]);
});

test("apply: waits for the provider, mounts when it appears, unmounts when it goes", () => {
  const f = fakeCtx({ withProvider: false });
  apply(f.ctx, {});
  assert.equal(f.registered.length, 0);
  f.handlers.get("subagent/provider-added")({ name: "fork" });
  assert.equal(f.registered.length, 0); // some other provider
  f.handlers.get("subagent/provider-added")({ name: "spawn" });
  assert.equal(f.registered.length, 2);
  f.handlers.get("subagent/provider-added")({ name: "spawn" });
  assert.equal(f.registered.length, 2); // not mounted twice
  f.handlers.get("subagent/provider-removed")("spawn");
  assert.equal(f.registered.length, 0);
});

test("apply: jev_watch is not registered when cost.enabled is false", () => {
  const f = fakeCtx();
  apply(f.ctx, { cost: { enabled: false } });
  assert.deepEqual(f.registered.map((t) => t.name), ["jev_run"]);
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
test("execute: refuses to run without a calling agent", async () => {
  const f = fakeCtx();
  const cfg = resolveConfig();
  const tool = buildTool(f.ctx, cfg, new Ledger(join(mkdtempSync(join(tmpdir(), "jev-")), "l.json"), cfg.budgets));
  await assert.rejects(tool.execute({ task: "t", cwd: "/x" }, { signal: new AbortController().signal }), /requires a calling agent/);
});

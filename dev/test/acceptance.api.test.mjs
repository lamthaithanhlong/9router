import "./_sandbox.mjs";
// Independent acceptance gate for SPEC.md section 1, 2 and 4.
//
// Written by the requester, NOT by the agent implementing the SPEC, so a
// passing run means the behaviour is really there and not just self-certified.
// It only uses the public seams the SPEC names: createApiSpawn(cfg, {fetchImpl})
// from lib/api.js, resolveConfig() from lib/config.js, and runPipeline(deps, input)
// from lib/pipeline.js.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/david-plugin/lib/config.js";
import { runPipeline } from "../../plugin/david-plugin/lib/pipeline.js";

const DS = "deepseek-v4.1-flash";
const APPROVE = '{"verdict":"approve","issues":[]}';
const RISKY = { files: [{ path: "src/auth/login.js", added: 9, removed: 2 }], diff: "diff --git a/src/auth/login.js" };

async function loadApi() {
  return import("../../plugin/david-plugin/lib/api.js");
}

function route(over = {}) {
  return {
    key: "api_test",
    provider: "api",
    model: "route-model",
    api: {
      baseUrl: "https://upstream.example/v1",
      keyEnv: "DAVID_ACCEPTANCE_KEY",
      model: "api-model",
      headers: { "x-tenant": "acme" },
      ...over,
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

test("api.js exists and exports createApiSpawn", async () => {
  const mod = await loadApi();
  assert.equal(typeof mod.createApiSpawn, "function");
});

test("happy path: request shape, text and usage are mapped", async () => {
  process.env.DAVID_ACCEPTANCE_KEY = "sekret-value";
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return jsonResponse({ choices: [{ message: { content: "PLAN OK" } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  };
  const { createApiSpawn } = await loadApi();
  const spawn = createApiSpawn(resolveConfig(), { fetchImpl });
  const out = await spawn(route(), "the prompt", "planner", "planner");

  assert.equal(out.text, "PLAN OK");
  assert.equal(out.tokensIn, 11);
  assert.equal(out.tokensOut, 7);

  const { url, init } = seen[0];
  assert.equal(url, "https://upstream.example/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-tenant"], "acme");
  assert.equal(init.headers.authorization, "Bearer sekret-value");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "api-model");
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "the prompt" }]);
});

test("path is overridable and content may be an array of text parts", async () => {
  process.env.DAVID_ACCEPTANCE_KEY = "k";
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return jsonResponse({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }], usage: { input_tokens: 3, output_tokens: 4 } });
  };
  const { createApiSpawn } = await loadApi();
  const spawn = createApiSpawn(resolveConfig(), { fetchImpl });
  const out = await spawn(route({ path: "/v1/custom" }), "p", "l", "role");
  assert.equal(calledUrl, "https://upstream.example/v1/v1/custom");
  assert.equal(out.text, "ab");
  assert.equal(out.tokensIn, 3);
  assert.equal(out.tokensOut, 4);
});

test("usage absent is not an error: both token counts are 0", async () => {
  process.env.DAVID_ACCEPTANCE_KEY = "k";
  const { createApiSpawn } = await loadApi();
  const spawn = createApiSpawn(resolveConfig(), { fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "hi" } }] }) });
  const out = await spawn(route(), "p", "l", "role");
  assert.deepEqual(out, { text: "hi", tokensIn: 0, tokensOut: 0 });
});

test("missing env var names the env var and keeps the pipeline fallback possible", async () => {
  delete process.env.DAVID_ACCEPTANCE_KEY;
  const { createApiSpawn } = await loadApi();
  const spawn = createApiSpawn(resolveConfig(), { fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(() => spawn(route(), "p", "l", "role"), (err) => {
    assert.match(String(err.message), /api route api_test needs env DAVID_ACCEPTANCE_KEY/);
    return true;
  });
});

test("HTTP failure reports status + body, never a key or an Authorization header", async () => {
  process.env.DAVID_ACCEPTANCE_KEY = "sekret-value";
  const { createApiSpawn } = await loadApi();
  const spawn = createApiSpawn(resolveConfig(), {
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return "upstream exploded"; }, async json() { return {}; } }),
  });
  await assert.rejects(() => spawn(route(), "p", "l", "role"), (err) => {
    const msg = String(err.message);
    assert.match(msg, /500/);
    assert.match(msg, /upstream exploded/);
    assert.ok(!msg.includes("sekret-value"), "the key value must never appear in an error");
    assert.ok(!/Bearer /i.test(msg), "an Authorization header must never appear in an error");
    return true;
  });
});

test("empty content is an error (an empty 200 is not a success)", async () => {
  process.env.DAVID_ACCEPTANCE_KEY = "k";
  const { createApiSpawn } = await loadApi();
  const spawn = createApiSpawn(resolveConfig(), { fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "   " } }] }) });
  await assert.rejects(() => spawn(route(), "p", "l", "role"));
});

test("api.enabled false (default): no api route and no chain mentions one", () => {
  const cfg = resolveConfig();
  const apiKeys = Object.entries(cfg.routes).filter(([, r]) => r.provider === "api").map(([k]) => k);
  assert.deepEqual(apiKeys, []);
  for (const [name, chain] of Object.entries(cfg.chains)) {
    for (const key of chain) assert.ok(!String(key).startsWith("api"), `chain ${name} still mentions ${key}`);
  }
});

test("api.enabled true: api routes sit directly before backup in the four text-only chains, worker untouched", () => {
  const base = resolveConfig();
  const cfg = resolveConfig({ api: { enabled: true } });
  const apiKeys = Object.entries(cfg.routes).filter(([, r]) => r.provider === "api").map(([k]) => k);
  assert.ok(apiKeys.length >= 2, "the SPEC asks for api_deepseek and api_openrouter");

  for (const name of ["planner", "researcher", "reviewer", "final_reviewer"]) {
    const chain = cfg.chains[name];
    const backupAt = chain.indexOf("backup");
    assert.ok(backupAt > 0, `chain ${name} has no backup`);
    assert.deepEqual(chain.slice(backupAt - apiKeys.length, backupAt), apiKeys, `api keys must sit right before backup in ${name}`);
  }
  assert.deepEqual(cfg.chains.worker, base.chains.worker);
});

test("pipeline charges the real token numbers when spawn returns them", async () => {
  const trace = [];
  // The pipeline really uses the Ledger (canSpend/charge), so a stub is not enough.
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "david-acc-")), "l.json"), DEFAULTS.budgets);
  const deps = {
    cfg: resolveConfig({ laya: { reviewEnabled: true } }),
    ledger,
    laya: { noul: async () => 0 },
    // No health stub: the pipeline calls optional methods on it (cooling/ok), and a
    // partial stub throws. The repo's own harness leaves it undefined here.
    log: () => {},
    loadPrompt: (role) => `ROLE: ${role}`,
    trace,
    async spawn(r) {
      // The reviewer is the paid route whose real token counts must be charged.
      if (r.model === DS) return { text: APPROVE, tokensIn: 100, tokensOut: 20 };
      // The final reviewer (Codex) must also return a readable verdict, or the
      // pipeline holds the run; that would be the test's fault, not the code's.
      if (r.model === "codex-head") return APPROVE;
      return "ok";
    },
    getChanges: async () => RISKY,
    runTests: async () => ({ passed: true, summary: "", ran: true }),
  };
  const out = await runPipeline(deps, {
    task: "touch auth", cwd: "/repo", tasks: ["touch auth"], research: [],
    allowedPaths: ["src/**"], testCommand: "true", finalReview: false,
  });
  assert.equal(out.status, "done");
  assert.equal(ledger.used("deepseek"), 120, "must charge tokensIn + tokensOut, not an estimate");
  const entry = trace.find((t) => t.role === "reviewer");
  assert.ok(entry, "the reviewer must appear in the trace");
  assert.equal(entry.tokensIn, 100);
  assert.equal(entry.tokensOut, 20);
});

import "./_sandbox.mjs";
// SPEC section 5 — tests for the HTTP API route path (lib/api.js + config gating +
// the real-token charge in lib/pipeline.js). Fake fetch only, no network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/david-plugin/lib/config.js";
import { runPipeline } from "../../plugin/david-plugin/lib/pipeline.js";

const KEY_ENV = "JEV_API_TEST_KEY";
const KEY_VALUE = "test-key-value-0123456789";
const DS = "deepseek-v4.1-flash";
const APPROVE = '{"verdict":"approve","issues":[]}';
const RISKY = { files: [{ path: "src/auth/login.js", added: 9, removed: 2 }], diff: "diff --git a/src/auth/login.js" };

const apiRoute = (over = {}) => ({
  key: "api_test",
  provider: "api",
  model: "route-model",
  api: { baseUrl: "https://api.example/v1", path: "/chat/completions", keyEnv: KEY_ENV, model: "api-model", headers: {}, ...over },
});

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

const load = () => import("../../plugin/david-plugin/lib/api.js");

test("happy path: text and usage are mapped from a string content", async () => {
  process.env[KEY_ENV] = KEY_VALUE;
  let seen;
  const { createApiSpawn } = await load();
  const spawn = createApiSpawn(resolveConfig(), {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return response({ choices: [{ message: { content: "ANSWER" } }], usage: { prompt_tokens: 40, completion_tokens: 8 } });
    },
  });
  const out = await spawn(apiRoute(), "the prompt", "reviewer", "reviewer");
  assert.deepEqual(out, { text: "ANSWER", tokensIn: 40, tokensOut: 8 });
  assert.equal(seen.url, "https://api.example/v1/chat/completions");
  assert.equal(seen.init.headers.authorization, `Bearer ${KEY_VALUE}`);
  assert.equal(JSON.parse(seen.init.body).stream, false);
});

test("content given as an array of {type:text,text} parts is joined", async () => {
  process.env[KEY_ENV] = KEY_VALUE;
  const { createApiSpawn } = await load();
  const spawn = createApiSpawn(resolveConfig(), {
    fetchImpl: async () => response({
      choices: [{ message: { content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] } }],
      usage: { input_tokens: 5, output_tokens: 6 },
    }),
  });
  const out = await spawn(apiRoute(), "p", "l", "role");
  assert.equal(out.text, "part one part two");
  assert.equal(out.tokensIn, 5);
  assert.equal(out.tokensOut, 6);
});

test("missing env var names the env var, and a set key value never appears in the message", async () => {
  delete process.env[KEY_ENV];
  const { createApiSpawn } = await load();
  const spawn = createApiSpawn(resolveConfig(), { fetchImpl: async () => response({}) });
  await assert.rejects(() => spawn(apiRoute(), "p", "l", "role"), (err) => {
    assert.match(String(err.message), new RegExp(`needs env ${KEY_ENV}`));
    return true;
  });

  // now with a key present, a failing upstream must still not leak its value
  process.env[KEY_ENV] = KEY_VALUE;
  const spawn2 = createApiSpawn(resolveConfig(), {
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return "boom"; }, async json() { return {}; } }),
  });
  await assert.rejects(() => spawn2(apiRoute(), "p", "l", "role"), (err) => {
    const msg = String(err.message);
    assert.ok(!msg.includes(KEY_VALUE), "the key value must not be logged");
    assert.ok(!/Bearer /i.test(msg), "no Authorization header in the message");
    return true;
  });
});

test("HTTP 500 throws with the status and the first body characters", async () => {
  process.env[KEY_ENV] = KEY_VALUE;
  const { createApiSpawn } = await load();
  const spawn = createApiSpawn(resolveConfig(), {
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return "upstream exploded"; }, async json() { return {}; } }),
  });
  await assert.rejects(() => spawn(apiRoute(), "p", "l", "role"), /HTTP 500[\s\S]*upstream exploded/);
});

test("a timeout aborts and throws", async () => {
  process.env[KEY_ENV] = KEY_VALUE;
  const { createApiSpawn } = await load();
  const spawn = createApiSpawn(resolveConfig(), {
    fetchImpl: (url, init) => new Promise((_, reject) => {
      // AbortSignal.timeout()'s timer is unref'd, so the fake must hold the event
      // loop open itself; otherwise the process exits before the abort fires.
      const keepAlive = setTimeout(() => {}, 1_000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason ?? new Error("aborted"));
      });
    }),
  });
  await assert.rejects(() => spawn(apiRoute({ timeoutMs: 25 }), "p", "l", "role"));
});

test("api.enabled false exposes no api route; true puts them right before backup in the text-only chains", () => {
  const off = resolveConfig();
  assert.deepEqual(Object.entries(off.routes).filter(([, r]) => r.provider === "api"), []);
  for (const chain of Object.values(off.chains)) {
    for (const key of chain) assert.ok(!String(key).startsWith("api"), `chain still lists ${key}`);
  }

  const on = resolveConfig({ api: { enabled: true } });
  const apiKeys = Object.entries(on.routes).filter(([, r]) => r.provider === "api").map(([k]) => k);
  assert.ok(apiKeys.length >= 2);
  for (const role of ["planner", "researcher", "reviewer", "final_reviewer"]) {
    const chain = on.chains[role];
    const backupAt = chain.indexOf("backup");
    assert.ok(backupAt > 0, `${role} lost its backup route`);
    assert.deepEqual(chain.slice(backupAt - apiKeys.length, backupAt), apiKeys, `${role}: api routes must sit right before backup`);
  }
  assert.deepEqual(on.chains.worker, off.chains.worker);
});

test("the ledger is charged the real tokens when the route reports them", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "jev-api-test-")), "l.json"), DEFAULTS.budgets);
  const trace = [];
  const deps = {
    cfg: resolveConfig({ laya: { reviewEnabled: true } }),
    ledger,
    laya: { noul: async () => 0 },
    log: () => {},
    loadPrompt: (role) => `ROLE: ${role}`,
    trace,
    async spawn(route) {
      if (route.model === DS) return { text: APPROVE, tokensIn: 100, tokensOut: 20 };
      if (route.model === "codex-head") return APPROVE;
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
  assert.equal(ledger.used("deepseek"), 120, "charge tokensIn + tokensOut, not an estimate");
  const reviewer = trace.find((t) => t.role === "reviewer");
  assert.equal(reviewer.tokensIn, 100);
  assert.equal(reviewer.tokensOut, 20);
});

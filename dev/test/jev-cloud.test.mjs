import "./_sandbox.mjs";
// Hosted Jev: key resolution (env over a 0600 file), the cloud-first/local-fallback
// client, and the daily token cap that keeps a runaway loop from spending.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS, resolveConfig } from "../../plugin/david-plugin/lib/config.js";
import { describeMissingSecret, readSecretFile, resolveSecret } from "../../plugin/david-plugin/lib/keys.js";
import { createLaya, isLoopback } from "../../plugin/david-plugin/lib/laya.js";
import { runPipeline } from "../../plugin/david-plugin/lib/pipeline.js";

const SECRET = "sekret-value-do-not-log";

test("keys: the environment wins, a 0600 file is the fallback, and neither in an error", () => {
  assert.deepEqual(resolveSecret({ keyEnv: "A" }, { env: { A: "from-env" } }), { value: "from-env", source: "env A" });

  const readFile = () => `${SECRET}\n`;
  assert.deepEqual(resolveSecret({ keyEnv: "MISSING", keyFile: "/x/y.key" }, { env: {}, readFile }), { value: SECRET, source: "file /x/y.key" });
  assert.equal(resolveSecret({ keyEnv: "MISSING" }, { env: {} }), null);
  assert.equal(readSecretFile("/x/y.key", { readFile: () => { throw new Error("EACCES"); } }), null);

  const missing = describeMissingSecret({ keyEnv: "A", keyFile: "/x/y.key" });
  assert.match(missing, /env A/);
  assert.match(missing, /\/x\/y\.key/);
  assert.ok(!missing.includes(SECRET));
});

test("laya: cloud first with the key and the model, and the real usage reported", async () => {
  const cfg = { ...DEFAULTS.laya, keyEnv: "TS_TEST_KEY", keyFile: "" };
  const seen = [];
  const laya = createLaya(cfg, {
    env: { TS_TEST_KEY: SECRET },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, json: async () => ({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.81 } }, usage: { input_tokens: 321 } }) };
    },
  });
  let usage;
  assert.equal(await laya.noul("q", "state", "instr", (u) => { usage = u; }), 0.81);
  assert.equal(seen.length, 1, "the cloud answered, so the local fallback must not run");
  assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen[0].init.headers.authorization, `Bearer ${SECRET}`);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.questions.q.type, "noul");
  assert.deepEqual(usage, { inputTokens: 321, model: "jev-latest", source: "cloud" });
});

test("laya: a cloud failure falls back to the local server, without an Authorization header", async () => {
  const cfg = { ...DEFAULTS.laya, keyEnv: "TS_TEST_KEY", keyFile: "" };
  const seen = [];
  const laya = createLaya(cfg, {
    env: { TS_TEST_KEY: SECRET },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      if (url.startsWith("https://")) throw new Error("ECONNRESET");
      return { ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.42 } } }) };
    },
  });
  let usage;
  assert.equal(await laya.noul("q", "state", "instr", (u) => { usage = u; }), 0.42);
  assert.equal(seen.length, 2);
  assert.equal(usage.source, "local");
  assert.equal(usage.model, null, "the local engine takes no model field");
  assert.equal(seen[1].url, "http://127.0.0.1:8130/v1/systemone");
  assert.equal(seen[1].init.headers.authorization, undefined);
  assert.equal(JSON.parse(seen[1].init.body).model, undefined, "laya-serve must not receive a model field");
});

test("laya: with no key at all it goes straight to the local server (old behaviour)", async () => {
  const cfg = { ...DEFAULTS.laya, keyEnv: "NOT_SET_ANYWHERE", keyFile: "/does/not/exist.key" };
  const seen = [];
  const laya = createLaya(cfg, {
    env: {},
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.5 } } }) }; },
  });
  assert.equal(await laya.noul("q", "s", "i"), 0.5);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:8130/v1/systemone");
});

test("laya: a failing cloud URL never starts the local server; a failing loopback does", async () => {
  const ctl = join(mkdtempSync(join(tmpdir(), "david-ctl-")), "laya-ctl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(ctl, "#!/bin/sh\n");
  const started = [];
  const spawnImpl = (cmd, args) => (started.push([cmd, ...args]), { unref() {} });

  assert.ok(isLoopback("http://127.0.0.1:8130"));
  assert.ok(!isLoopback("https://api.typesafe.ai"));

  const cloudOnly = createLaya({ ...DEFAULTS.laya, keyEnv: "K", keyFile: "", ctl, fallbackUrl: "" }, {
    env: { K: SECRET }, spawnImpl, fetchImpl: async () => { throw new Error("down"); },
  });
  assert.equal(await cloudOnly.noul("q", "s", "i"), null);
  assert.deepEqual(started, [], "a cloud failure must not spawn laya-ctl");

  const withFallback = createLaya({ ...DEFAULTS.laya, keyEnv: "K", keyFile: "", ctl }, {
    env: { K: SECRET }, spawnImpl, fetchImpl: async () => { throw new Error("down"); },
  });
  assert.equal(await withFallback.noul("q", "s", "i"), null);
  assert.deepEqual(started, [[ctl, "start"]]);
});

test("api: the key may also come from a file, named (never valued) in the error", async () => {
  const { createApiSpawn } = await import("../../plugin/david-plugin/lib/api.js");
  const readFile = () => `${SECRET}\n`;
  let seen;
  const spawn = createApiSpawn(resolveConfig(), {
    readFile,
    fetchImpl: async (url, init) => { seen = init; return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }; },
  });
  const route = { key: "api_file", provider: "api", model: "m", api: { baseUrl: "https://x/v1", keyEnv: "NOT_SET", keyFile: "~/k.key", timeoutMs: 1000 } };
  const out = await spawn(route, "p", "l", "r");
  assert.equal(out.text, "ok");
  assert.equal(seen.headers.authorization, `Bearer ${SECRET}`);

  const broken = createApiSpawn(resolveConfig(), { readFile: () => { throw new Error("ENOENT"); }, fetchImpl: async () => assert.fail("must not call") });
  await assert.rejects(() => broken(route, "p", "l", "r"), (err) => {
    assert.match(String(err.message), /needs env NOT_SET or file ~\/k\.key/);
    assert.ok(!String(err.message).includes(SECRET));
    return true;
  });
});

test("pipeline: the Jev call is metered, and the daily cap skips it instead of spending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "david-cloud-"));
  const ledger = new Ledger(join(dir, "ledger.json"), DEFAULTS.budgets);

  // Under the cap: the real input tokens are charged.
  let asked = false;
  const deps = {
    cfg: resolveConfig(),
    ledger,
    laya: { noul: async (id, state, instructions, onUsage) => { asked = true; onUsage?.({ inputTokens: 321, source: "cloud" }); return 0.9; } },
    log: () => {}, loadPrompt: (r) => r, trace: [],
    spawn: async () => "ok",
    getChanges: async () => ({ files: [{ path: "src/a.js", added: 1, removed: 0 }], diff: "diff" }),
    runTests: async () => ({ passed: true, summary: "", ran: true }),
  };
  const input = { task: "fix the bug", cwd: "/repo", tasks: ["fix the bug"], research: [], allowedPaths: ["src/**"], testCommand: "true", finalReview: false };
  await runPipeline(deps, input);
  assert.ok(asked, "laya must be asked when under the cap");
  assert.equal(ledger.used("laya"), 1, "one hosted question costs one unit, whatever its token count");
  assert.equal(ledger.remaining("laya"), DEFAULTS.budgets.laya.daily - 1);

  // Over the quota: the hosted endpoint must not be used for the rest of the day.
  while (ledger.canSpend("laya", 1, "laya")) ledger.charge("laya", 0);
  const spentBefore = ledger.used("laya");
  let askedOpts = null;
  const deps2 = {
    ...deps, trace: [],
    laya: { noul: async (id, state, instructions, onUsage, opts) => { askedOpts = opts; onUsage?.({ inputTokens: 0, source: "local" }); return 0.9; } },
  };
  await runPipeline(deps2, input);
  assert.deepEqual(askedOpts, { cloud: false }, "the cap must forbid the hosted call, not the local one");
  // Over the quota the cloud is skipped, but the free local engine still answers,
  // so a day never loses its plan decision just because the quota ran out.
  const entry = deps2.trace.find((t) => t.role === "laya");
  assert.equal(entry.status, "ok");
  assert.equal(entry.source, "local");
  assert.match(String(entry.detail2), /quota spent/);
  assert.equal(ledger.used("laya"), spentBefore, "a local answer adds nothing to the quota");
});

test("laya: opts.cloud === false never touches the hosted endpoint", async () => {
  const cfg = { ...DEFAULTS.laya, keyEnv: "TS_TEST_KEY", keyFile: "" };
  const seen = [];
  const laya = createLaya(cfg, {
    env: { TS_TEST_KEY: SECRET },
    fetchImpl: async (url, init) => { seen.push(url); return { ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.2 } } }) }; },
  });
  assert.equal(await laya.noul("q", "s", "i", null, { cloud: false }), 0.2);
  assert.deepEqual(seen, ["http://127.0.0.1:8130/v1/systemone"]);
});

test("pipeline: a local fallback answer does not consume the hosted question quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "david-quota-"));
  const ledger = new Ledger(join(dir, "ledger.json"), DEFAULTS.budgets);
  const deps = {
    cfg: resolveConfig(),
    ledger,
    laya: { noul: async (id, state, instructions, onUsage) => { onUsage?.({ inputTokens: 53, model: null, source: "local" }); return 0.9; } },
    log: () => {}, loadPrompt: (r) => r, trace: [],
    spawn: async () => "ok",
    getChanges: async () => ({ files: [{ path: "src/a.js", added: 1, removed: 0 }], diff: "diff" }),
    runTests: async () => ({ passed: true, summary: "", ran: true }),
  };
  await runPipeline(deps, { task: "fix the bug", cwd: "/repo", tasks: ["fix the bug"], research: [], allowedPaths: ["src/**"], testCommand: "true", finalReview: false });
  assert.equal(ledger.used("laya"), 0, "the free local engine must not spend the paid quota");
  const entry = deps.trace.find((t) => t.role === "laya");
  assert.equal(entry.source, "local");
  assert.equal(entry.tokensIn, undefined);
});

test("laya: a hosted 429 marks the route spent for the day and stops asking it", async () => {
  const cfg = { ...DEFAULTS.laya, keyEnv: "TS_TEST_KEY", keyFile: "" };
  const seen = [];
  let day = Date.parse("2026-10-07T10:00:00Z");
  const laya = createLaya(cfg, {
    env: { TS_TEST_KEY: SECRET },
    now: () => day,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.startsWith("https://")) return { ok: false, status: 429, async text() { return '{"error":{"message":"quota exceeded"}}'; } };
      return { ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.3 } } }) };
    },
  });
  assert.equal(await laya.noul("q", "s", "i"), 0.3);              // cloud 429 -> local answers
  assert.equal(seen.filter((u) => u.startsWith("https://")).length, 1);
  assert.equal(await laya.noul("q", "s", "i"), 0.3);              // no second cloud attempt
  assert.equal(seen.filter((u) => u.startsWith("https://")).length, 1, "the spent route must not be retried");
  day += 86_400_000;                                              // next UTC day: try the cloud again
  assert.equal(await laya.noul("q", "s", "i"), 0.3);
  assert.equal(seen.filter((u) => u.startsWith("https://")).length, 2, "a new day restores the hosted attempt");
});

test("laya: isQuotaError only fires on quota-shaped failures", async () => {
  const { isQuotaError } = await import("../../plugin/david-plugin/lib/laya.js");
  assert.equal(isQuotaError(429, ""), true);
  assert.equal(isQuotaError(402, ""), true);
  assert.equal(isQuotaError(403, '{"error":"insufficient balance"}'), true);
  assert.equal(isQuotaError(500, "internal error"), false);
  assert.equal(isQuotaError(400, "bad request"), false);
});

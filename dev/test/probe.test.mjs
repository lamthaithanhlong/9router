import { SANDBOX_HOME } from "./_sandbox.mjs";
// SPEC 0.7.0 part D: the probe. A route that answers HTTP 200 with no text must be reported as
// dead — that is exactly how the Cursor route fails, and 9Router records it as a success.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createProbe } from "../../plugin/jev-orchestrator/lib/probe.js";
import { resolveConfig } from "../../plugin/jev-orchestrator/lib/config.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const pong = () => json({ choices: [{ message: { content: "PONG" } }] });

function probeWith(fetchImpl, cfgOver = {}) {
  const cfg = resolveConfig(cfgOver);
  const logs = [];
  const probe = createProbe(cfg, { log: (m) => logs.push(m), fetchImpl });
  return { probe, cfg, logs };
}

test("probe: PONG means alive", async () => {
  const { probe } = probeWith(async () => pong());
  const r = await probe.probe("cursor");
  assert.equal(r.ok, true);
  assert.equal(r.sample, "PONG");
  assert.match(r.reason, /PONG/);
});

test("probe: an empty 200 is a failure, and the reason names it", async () => {
  const { probe, logs } = probeWith(async () => json({ choices: [{ message: { content: "" } }] }));
  const r = await probe.probe("cursor");
  assert.equal(r.ok, false);
  assert.equal(r.chars, 0);
  assert.match(r.reason, /empty reply/);
  assert.ok(logs.some((m) => /probe cursor: empty reply/.test(m)), "a dead route is logged");
});

test("probe: unrelated text is not an answer either", async () => {
  // The measured failure mode: an error token carried inside an HTTP 200 body.
  const { probe } = probeWith(async () => json({ choices: [{ message: { content: "ERROR_NOT_LOGGED_IN" } }] }));
  const r = await probe.probe("cursor");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unexpected reply/);
});

test("probe: an HTTP error is a failure", async () => {
  const { probe } = probeWith(async () => json({ error: "nope" }, 401));
  const r = await probe.probe("cursor");
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 401/);
});

test("probe: a timeout is not an answer", async () => {
  // AbortSignal.timeout() is an unref'd timer: without something ref'd on the loop, node drains
  // and the abort never fires. The keepAlive timer below holds the loop open until it does, so
  // this exercises the real abort path rather than a hand-rolled rejection.
  const { probe } = probeWith(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 500);
        init.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      }),
    { probe: { timeoutMs: 20 } },
  );
  const r = await probe.probe("cursor");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no answer within 20ms/);
});

test("probe: a second ask within ttlMs does not call upstream again, forget() forces a new one", async () => {
  let calls = 0;
  const { probe } = probeWith(async () => (calls++, pong()));
  await probe.probe("cursor");
  await probe.probe("cursor");
  assert.equal(calls, 1);
  probe.forget("cursor");
  await probe.probe("cursor");
  assert.equal(calls, 2);
});

test("probe: authenticates with the provider bearer key, not the dashboard CLI token", async () => {
  // Caught by the live smoke test: /v1/chat/completions answers HTTP 401 to x-9r-cli-token (that
  // header belongs to the dashboard), so the probe must send a real API key.
  const prev = process.env.ROUTER9_API_KEY;
  process.env.ROUTER9_API_KEY = "sk-test-key";
  try {
    const calls = [];
    const { probe } = probeWith(async (url, init) => (calls.push({ url, init }), pong()));
    const r = await probe.probe("cursor");
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/chat\/completions$/);
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-key");
    assert.ok(!("x-9r-cli-token" in calls[0].init.headers), "the dashboard token is the wrong credential for /v1");
    assert.equal(JSON.parse(calls[0].init.body).model, "cursor-workers");
    // A reasoning route spends its budget on thinking first, so a tight max_tokens truncates the
    // visible answer and makes a healthy route look dead (measured: 8 -> "P", 64 -> "PONG").
    const asked = JSON.parse(calls[0].init.body).max_tokens;
    assert.ok(asked >= 64, `the probe must not starve the answer (asked for ${asked} tokens)`);
  } finally {
    if (prev === undefined) delete process.env.ROUTER9_API_KEY;
    else process.env.ROUTER9_API_KEY = prev;
  }
});

test("probe: falls back to the active key in 9Router's own database when the env var is absent", async () => {
  const prev = process.env.ROUTER9_API_KEY;
  delete process.env.ROUTER9_API_KEY;
  try {
    const dir = join(SANDBOX_HOME, ".9router", "db");
    mkdirSync(dir, { recursive: true });
    const dbFile = join(dir, "data.sqlite");
    rmSync(dbFile, { force: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("create table apiKeys (id integer primary key, key text, isActive int); insert into apiKeys (key, isActive) values ('sk-from-db', 1);");
    db.close();

    const calls = [];
    const cfg = resolveConfig({ cost: { dbFile: "~/.9router/db/data.sqlite" } });
    const probe = createProbe(cfg, { log: () => {}, fetchImpl: async (url, init) => (calls.push({ url, init }), pong()) });
    const r = await probe.probe("cursor");
    assert.equal(r.ok, true);
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-from-db");
  } finally {
    if (prev !== undefined) process.env.ROUTER9_API_KEY = prev;
  }
});

test("probe: only the routes flagged probe:true are asked", () => {
  const { probe } = probeWith(async () => pong());
  assert.deepEqual(probe.probedRouteKeys().sort(), ["cursor"], "the manager office is a seat now: codex and deepseek answer when they answer, so probing them would spend quota or money for nothing");
});

test("probe: an unknown route is a failure, never a throw", async () => {
  const { probe } = probeWith(async () => pong());
  const r = await probe.probe("no-such-route");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown route/);
});

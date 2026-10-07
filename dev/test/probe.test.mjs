import "./_sandbox.mjs";
// SPEC 0.7.0 part D: the probe. A route that answers HTTP 200 with no text must be reported as
// dead — that is exactly how the Cursor route fails, and 9Router records it as a success.
import assert from "node:assert/strict";
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

test("probe: only the routes flagged probe:true are asked", () => {
  const { probe } = probeWith(async () => pong());
  assert.deepEqual(probe.probedRouteKeys().sort(), ["cursor", "manager"]);
});

test("probe: an unknown route is a failure, never a throw", async () => {
  const { probe } = probeWith(async () => pong());
  const r = await probe.probe("no-such-route");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown route/);
});

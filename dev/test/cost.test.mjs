import { SANDBOX_HOME } from "./_sandbox.mjs";
// SPEC 0.7.0 part C: cost tracker behaviour. Builds a temp SQLite with `node:sqlite` and feeds
// it a few usageHistory / usageDaily rows, so we can exercise the watermark filter, the rolling
// average and the missing-DB fallback without touching 9Router on the host.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCostTracker, matchUsage } from "../../plugin/david-plugin/lib/cost.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-cost-"));

// Build a small, real 9Router-like database: one usageHistory row per call and one usageDaily
// row per UTC day. 9Router's table names are the public contract we read.
async function buildDb(usageRows = [], daily = [], file = join(tmp(), "data.sqlite")) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "create table usageHistory (id integer primary key, timestamp text, provider text, model text, promptTokens int, completionTokens int, cost real, tokens text);" +
    "create table usageDaily (dateKey text primary key, data text);"
  );
  for (const r of usageRows) appendUsageRaw(db, r);
  const d = db.prepare("insert into usageDaily (dateKey, data) values (?, ?)");
  for (const [key, data] of daily) d.run(key, JSON.stringify(data));
  db.close();
  return file;
}

// Append one row to an existing DB (the test simulates 9Router writing a new row between the
// snapshot() and the reconcile() of one call).
async function appendUsage(file, row) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  appendUsageRaw(db, row);
  db.close();
}
function appendUsageRaw(db, r) {
  db.prepare("insert into usageHistory (id, timestamp, provider, model, promptTokens, completionTokens, cost, tokens) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(r.id, r.ts ?? "2026-10-07T10:00:00.000Z", r.provider, r.model, r.pTokens ?? 100, r.cTokens ?? 10, r.cost, "{}");
}

test("snapshot: highest id in usageHistory, -1 when the file is missing", async () => {
  const missing = join(tmp(), "nope.sqlite");
  const t = createCostTracker({ cost: { dbFile: missing } }, { log: () => {} });
  assert.equal(t.snapshot(), -1);
  const file = await buildDb([{ id: 7, provider: "router9", model: "cursor-workers", cost: 0.001 }]);
  const t2 = createCostTracker({ cost: { dbFile: file } }, { log: () => {} });
  assert.equal(t2.snapshot(), 7);
});

test("a raw ~ path is expanded here too, so a caller that forgets expandHome loses nothing", async () => {
  // The live smoke test caught this: index.js expands the path, but createCostTracker did not,
  // so a direct call with the documented default ("~/.9router/db/data.sqlite") opened nothing
  // and every method answered zero for the whole day — silently, with one log line.
  const dir = join(SANDBOX_HOME, ".9router", "db");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "data.sqlite");
  rmSync(file, { force: true });
  await buildDb([{ id: 3, provider: "mvn", model: "deepseek-v4.1-flash", cost: 0.0005 }], [], file);
  const t = createCostTracker({ cost: { dbFile: "~/.9router/db/data.sqlite" } }, { log: () => {} });
  assert.equal(t.snapshot(), 3, "the tilde was expanded and the database opened");
});

test("reconcile: matches THIS route's 9Router rows, and charges NOTHING when none match", async () => {
  // The rows are what 9Router really writes: the RESOLVED upstream call, never our combo name.
  const file = await buildDb([
    { id: 1, ts: "2026-10-07T10:00:01.000Z", provider: "codex", model: "gpt-6.1-sol", cost: 0.10 },
    { id: 2, ts: "2026-10-07T10:00:02.000Z", provider: "codex", model: "gpt-6.1-sol", cost: 0.20 },
    { id: 3, ts: "2026-10-07T10:00:03.000Z", provider: "openai-compatible-chat-8ec45c8c", model: "deepseek-v4.1-flash", cost: 0.05 },
    { id: 4, ts: "2026-10-07T10:00:04.000Z", provider: "cursor", model: "claude-4.6-opus-max", cost: 0.30 },
    { id: 5, ts: "2026-10-07T10:00:05.000Z", provider: "deepseek-account", model: "deepseek-flash", cost: 9.99 }, // the head agent itself
  ]);
  const t = createCostTracker({ cost: { dbFile: file } }, { log: () => {} });

  // Route codex, described the way lib/config.js describes it now.
  let r = await t.reconcile(0, { routeKey: "codex", usage: { provider: "codex" } });
  assert.ok(Math.abs(r.usd - 0.30) < 1e-9, `0.10 + 0.20, got ${r.usd}`);
  assert.equal(r.calls, 2);
  assert.equal(r.unmatched, 3, "other apps' rows are reported, never charged");

  // Route deepseek: the 9Router node uuid changes, so config matches prefix + model.
  r = await t.reconcile(0, { routeKey: "deepseek", usage: { provider: "openai-compatible-chat-*", model: "deepseek-v4.1-flash" } });
  assert.equal(r.usd, 0.05);
  assert.equal(r.calls, 1);

  // Nothing matches -> the window is NOT charged. This is the bug that billed one worker $3.5211
  // of other processes' traffic on 2026-10-07 and knocked the run off the only money route.
  r = await t.reconcile(0, { routeKey: "weird", usage: { provider: "nowhere", model: "none" } });
  assert.equal(r.usd, 0);
  assert.equal(r.calls, 0);
  assert.equal(r.unmatched, 5);
});

test("reconcile: a retry combo reports one logical call as N upstream attempts", async () => {
  // Measured on a second Mac 2026-10-10: one 52,794-token prompt, 7 upstream rows of $0.110868,
  // zero output tokens. The wallet must see the 7x, and the learned per-call cost must then make
  // the per-call cap refuse that route.
  const rows = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, provider: "deepseek_tur_host", model: "deepseek-v4.1-flash", cost: 0.110868 }));
  const file = await buildDb(rows);
  const t = createCostTracker({ cost: { dbFile: file } }, { log: () => {} });
  const r = await t.reconcile(0, { routeKey: "deepseek", usage: { provider: "deepseek_tur_host" } });
  assert.equal(r.calls, 7, "seven upstream rows for one prompt");
  assert.ok(Math.abs(r.usd - 0.776076) < 1e-9, "the money is summed, not averaged away");
  assert.ok(t.assumeUsd("deepseek") > 0.02, "the next call on that route is over the call cap");
});

test("matchUsage: exact, list, trailing-* glob, case-insensitive; an empty descriptor is nothing", () => {
  const row = { provider: "openai-compatible-chat-8ec45c8c", model: "deepseek-v4.1-flash" };
  assert.equal(matchUsage(row, { provider: "openai-compatible-chat-8ec45c8c" }), true);
  assert.equal(matchUsage(row, { provider: "openai-compatible-chat-*", model: "deepseek-v4.1-flash" }), true);
  assert.equal(matchUsage(row, { provider: ["cursor", "opencode"] }), false);
  assert.equal(matchUsage(row, { provider: "OPENAI-COMPATIBLE-CHAT-8EC45C8C" }), true, "case-insensitive");
  assert.equal(matchUsage(row, { model: "deepseek*" }), true);
  assert.equal(matchUsage(row, { provider: ["cursor", "codex"] }), false);
  assert.equal(matchUsage(row, {}), false, "an empty descriptor describes nothing");
  assert.equal(matchUsage(row, null), false);
  assert.equal(matchUsage(row, { model: "gpt-6.1-sol" }), false);
});

test("assumeUsd: cfg override beats the rolling average, then average, then 0", async () => {
  // No rows yet: with no override and no average, assumeUsd is 0.
  const file = await buildDb([], []);
  const fresh = createCostTracker({ cost: { dbFile: file } }, { log: () => {} });
  assert.equal(fresh.assumeUsd("cursor"), 0);

  // First "call": 9Router writes one row AFTER the watermark.
  const w1 = await fresh.snapshot(); // 0 (no rows)
  await appendUsage(file, { id: 1, provider: "router9", model: "cursor-workers", cost: 0.04 });
  const r1 = await fresh.reconcile(w1, { routeKey: "cursor", provider: "router9", model: "cursor-workers" });
  // One call seen -> rolling average = its per-call cost.
  assert.equal(fresh.assumeUsd("cursor"), 0.04);

  // Second "call": rolling average with weight 0.5. New per-call is 0.02 -> (0.04*0.5 + 0.02*0.5) = 0.03.
  const w2 = await fresh.snapshot();
  await appendUsage(file, { id: 2, provider: "router9", model: "cursor-workers", cost: 0.02 });
  const r2 = await fresh.reconcile(w2, { routeKey: "cursor", provider: "router9", model: "cursor-workers" });
  assert.equal(fresh.assumeUsd("cursor"), 0.03);

  // cfg.cost.assume[routeKey] wins over the rolling average.
  const overridden = createCostTracker({ cost: { dbFile: file, assume: { cursor: 0.0335 } } }, { log: () => {} });
  assert.equal(overridden.assumeUsd("cursor"), 0.0335);
});

test("chargeTaskUsd / taskUsd: the per-task accumulator", async () => {
  const t = createCostTracker({ cost: { dbFile: "/nonexistent" } }, { log: () => {} });
  assert.equal(t.taskUsd(), 0);
  t.chargeTaskUsd(0.01);
  t.chargeTaskUsd(0.005);
  assert.equal(t.taskUsd(), 0.015);
  // garbage is ignored
  t.chargeTaskUsd("not a number");
  assert.equal(t.taskUsd(), 0.015);
});

test("dayUsd: from usageDaily; null when the DB or the row is missing", async () => {
  const missing = createCostTracker({ cost: { dbFile: "/nonexistent" } }, { log: () => {} });
  assert.equal(await missing.dayUsd(), null);

  const dateKey = new Date().toISOString().slice(0, 10);
  const file = await buildDb([], [[dateKey, { requests: 12, promptTokens: 1500, completionTokens: 200, cost: 0.789 }]]);
  const t = createCostTracker({ cost: { dbFile: file } }, { log: () => {} });
  const d = await t.dayUsd();
  assert.equal(d.dateKey, dateKey);
  assert.equal(d.usd, 0.789);
  assert.equal(d.requests, 12);
});

test("recentCalls: newest-first list of calls with token counts and cost", async () => {
  const file = await buildDb([
    { id: 1, ts: "2026-10-07T10:00:01.000Z", provider: "router9", model: "cursor-workers", cost: 0.01, pTokens: 1000, cTokens: 100 },
    { id: 2, ts: "2026-10-07T10:00:02.000Z", provider: "deepseek-host", model: "deepseek-v4.1-flash", cost: 0.0002, pTokens: 2000, cTokens: 50 },
    { id: 3, ts: "2026-10-07T10:00:03.000Z", provider: "router9", model: "codex-head", cost: 0.02, pTokens: 5000, cTokens: 500 },
  ]);
  const t = createCostTracker({ cost: { dbFile: file } }, { log: () => {} });
  const list = await t.recentCalls(2);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.model), ["codex-head", "deepseek-v4.1-flash"]); // newest first
  assert.equal(list[0].cost, 0.02);
  assert.equal(list[1].promptTokens, 2000);
});

test("every method is the zero / null answer when the DB file does not exist", async () => {
  const t = createCostTracker({ cost: { dbFile: "/nonexistent/never.sqlite" } }, { log: () => {} });
  assert.equal(t.snapshot(), -1);
  assert.deepEqual(await t.reconcile(0, { routeKey: "x" }), { usd: 0, calls: 0, unmatched: 0 });
  assert.equal(t.assumeUsd("x"), 0);
  assert.equal(await t.dayUsd(), null);
  assert.deepEqual(await t.recentCalls(5), []);
});

test("every method logs once, never throws, when the DB exists and is corrupt", async () => {
  // A file that exists but isn't a SQLite database: opening it must not crash the run.
  const dir = tmp();
  const corrupt = join(dir, "data.sqlite");
  writeFileSync(corrupt, "not a database");
  const seen = [];
  const t = createCostTracker({ cost: { dbFile: corrupt } }, { log: (m) => seen.push(m) });
  assert.equal(t.snapshot(), -1);
  assert.deepEqual(await t.reconcile(0, { routeKey: "x" }), { usd: 0, calls: 0, unmatched: 0 });
  assert.equal(t.assumeUsd("x"), 0);
  assert.equal(await t.dayUsd(), null);
  assert.deepEqual(await t.recentCalls(5), []);
  assert.ok(seen.length >= 1, "the tracker must log when it gives up");
  rmSync(dir, { recursive: true, force: true });
});
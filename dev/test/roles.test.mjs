import { SANDBOX_HOME } from "./_sandbox.mjs";
// The manager seat: an office held alternately by Codex and DeepSeek-host. Round-robin means the
// alternation is real - if it were priority, Codex would take every planner call until its quota
// ran out, which is exactly what the owner did not want.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSeat, pickSeatMember, resolveRole } from "../../plugin/jev-orchestrator/lib/roles.js";

const cfg = () => ({
  routes: {
    codex: { provider: "router9", model: "codex-head", cost: "quota", group: "codex", usage: { provider: "codex" } },
    deepseek: { provider: "deepseek-host", model: "deepseek-v4.1-flash", cost: "money", group: "deepseek" },
    manager: { rotate: ["codex", "deepseek"] },
    mentor: { rotate: ["codex", "deepseek"] },
    backup: { provider: "router9", model: "backup-free", cost: "free", backup: true, group: "backup" },
    cursor: { provider: "router9", model: "cursor-workers", cost: "free", group: "cursor", probe: true },
  },
  chains: { planner: ["manager", "backup"], reviewer: ["mentor", "backup"], worker: ["deepseek", "cursor", "backup"] },
  budgets: {},
});

const ledger = (out = []) => ({ canSpend: (key) => !out.includes(key), charge() {} });
const health = (cooling = []) => ({ cooling: (k) => cooling.includes(k), ok() {}, fail() {} });

test("a seat is a definition with rotate, and a member is never itself a seat", () => {
  const c = cfg();
  assert.equal(isSeat(c.routes.manager), true);
  assert.equal(isSeat(c.routes.codex), false);
  assert.equal(isSeat(undefined), false);
  assert.equal(isSeat({ rotate: [] }), false, "an empty seat is not a seat");
});

test("manager seat: round-robin, not priority", () => {
  const c = cfg();
  const rotation = new Map();
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    const r = resolveRole("planner", c, ledger(), 100, { rotation });
    seen.push(r.route.key);
    assert.equal(r.route.via, "manager", "the trace must name the office it came from");
    assert.equal(r.fellBack, false, "the seat is the first entry of the chain");
  }
  assert.deepEqual(seen, ["codex", "deepseek", "codex", "deepseek", "codex"]);
  assert.equal(rotation.get("manager"), 5, "one turn per hand-out");
});

test("manager seat: turns are numbered, and the returned route is the MEMBER", () => {
  const c = cfg();
  const rotation = new Map();
  const first = resolveRole("planner", c, ledger(), 100, { rotation });
  assert.equal(first.route.key, "codex");
  assert.equal(first.route.turn, 1);
  assert.equal(first.route.model, "codex-head", "caps, probe and the ledger are keyed by the member");
  const second = resolveRole("planner", c, ledger(), 100, { rotation });
  assert.equal(second.route.key, "deepseek");
  assert.equal(second.route.turn, 2);
});

test("manager seat: the member on turn being skipped does not disturb the alternation", () => {
  const c = cfg();
  const rotation = new Map();
  // Codex failed earlier in THIS call, so DeepSeek covers codex's turn...
  const covered = resolveRole("planner", c, ledger(), 100, { skip: ["codex"], rotation });
  assert.equal(covered.route.key, "deepseek");
  assert.equal(covered.route.turn, 2, "codex's turn was consumed by its substitute");
  // ...and the next call goes back to codex, not to deepseek twice.
  const next = resolveRole("planner", c, ledger(), 100, { rotation });
  assert.equal(next.route.key, "codex");
});

test("manager seat: a member that is cooling or out of budget hands the turn over", () => {
  const c = cfg();
  const a = resolveRole("planner", c, ledger(), 100, { health: health(["codex"]), rotation: new Map() });
  assert.equal(a.route.key, "deepseek");
  const b = resolveRole("planner", c, ledger(["codex"]), 100, { rotation: new Map() });
  assert.equal(b.route.key, "deepseek");
  // DeepSeek out of budget too, codex still cooling: the seat offers nothing, so the chain falls
  // through to backup and says so.
  const d = resolveRole("planner", c, ledger(["codex", "deepseek"]), 100, { rotation: new Map() });
  assert.equal(d.route.key, "backup");
  assert.equal(d.fellBack, true);
});

test("manager seat: when no member can take it the chain still falls through", () => {
  const c = cfg();
  const r = resolveRole("planner", c, ledger(["codex", "deepseek"]), 100, { rotation: new Map() });
  assert.equal(r.kind, "route");
  assert.equal(r.route.key, "backup");
  assert.equal(r.route.via, undefined);
  // And when the fallthrough is gone too, the role is held for a human rather than silently skipped.
  const held = resolveRole("planner", c, ledger(["codex", "deepseek", "backup"]), 100, { rotation: new Map() });
  assert.equal(held.kind, "hold");
  assert.match(held.reason, /budget exhausted/);
});

test("seats keep separate counters", () => {
  const c = cfg();
  const rotation = new Map();
  assert.equal(resolveRole("planner", c, ledger(), 100, { rotation }).route.key, "codex");
  assert.equal(resolveRole("reviewer", c, ledger(), 100, { rotation }).route.key, "codex", "its own counter, still at turn 0");
  assert.equal(resolveRole("planner", c, ledger(), 100, { rotation }).route.key, "deepseek");
  assert.equal(resolveRole("reviewer", c, ledger(), 100, { rotation }).route.key, "deepseek");
  assert.equal(rotation.get("manager"), 2);
  assert.equal(rotation.get("mentor"), 2);
});

test("a plain chain is untouched by the seat logic", () => {
  const c = cfg();
  const r = resolveRole("worker", c, ledger(), 100, {});
  assert.equal(r.route.key, "deepseek");
  assert.equal(r.route.via, undefined);
  assert.equal(r.fellBack, false);
  // The seat counter store is optional: a caller with no rotation still gets a working route.
  const seat = resolveRole("planner", c, ledger(), 100, {});
  assert.equal(seat.route.key, "codex");
});

test("pickSeatMember: reports the turn and refuses a seat whose members are all seats or missing", () => {
  const c = cfg();
  const rotation = new Map();
  const picked = pickSeatMember("manager", c, ledger(), 100, { rotation, role: "planner" });
  assert.equal(picked.key, "codex");
  assert.equal(picked.turn, 1);
  assert.equal(picked.def.model, "codex-head");
  const empty = { routes: { seat: { rotate: ["gone", "also-gone"] } }, budgets: {} };
  assert.equal(pickSeatMember("seat", empty, ledger(), 100, { rotation: new Map() }), null);
});

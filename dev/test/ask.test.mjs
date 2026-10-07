import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { DEFAULTS } from "../../plugin/david-plugin/lib/config.js";
import { ASK_WORDS, formatAnswer, runAsk } from "../../plugin/david-plugin/lib/pipeline.js";

function deps(spawn) {
  const calls = [];
  return {
    calls,
    cfg: DEFAULTS,
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "david-")), "l.json"), DEFAULTS.budgets),
    laya: { noul: async () => 0.1 },
    log: () => {},
    trace: [],
    loadPrompt: (r) => `PROMPT<${r}>`,
    spawn: async (route, prompt, label, role) => (calls.push({ route, prompt, label, role }), spawn ? spawn(route) : "the answer"),
    getChanges: async () => { throw new Error("an investigation has no diff"); },
    runTests: async () => { throw new Error("an investigation has no tests"); },
  };
}

test("runAsk: one researcher call with the ask prompt, no diff and no tests", async () => {
  const d = deps();
  const out = await runAsk(d, { task: "where is X?", cwd: "/some/dir" });
  assert.equal(out.status, "ok");
  assert.equal(out.answer, "the answer");
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].role, "researcher");
  assert.equal(d.calls[0].label, "ask");
  assert.match(d.calls[0].prompt, /^PROMPT<ask>/, "the ask prompt, not the researcher's GitHub one");
  assert.match(d.calls[0].prompt, /# QUESTION\nwhere is X\?/);
  assert.match(d.calls[0].prompt, /Look in \/some\/dir/);
});

test("runAsk: the word limit is clamped to what makes sense", async () => {
  const limit = async (words) => (await (async () => { const d = deps(); await runAsk(d, { task: "q", cwd: "/d", words }); return /Word limit for your reply: (\d+)/.exec(d.calls[0].prompt)[1]; })());
  assert.equal(await limit(undefined), String(ASK_WORDS.dflt));
  assert.equal(await limit(5), String(ASK_WORDS.min));
  assert.equal(await limit(99999), String(ASK_WORDS.max));
  assert.equal(await limit(250), "250");
  assert.equal(await limit("nonsense"), String(ASK_WORDS.dflt));
});

test("runAsk: when every route fails it hands the question back to a person, with each route's reason (no empty answer)", async () => {
  const d = deps(() => { throw new Error("upstream down"); });
  const out = await runAsk(d, { task: "q", cwd: "/d" });
  assert.equal(out.status, "awaiting_human");
  assert.equal(out.answer, "");
  assert.match(out.notes[0], /every route failed or is out of budget/);
  assert.match(out.notes[0], /codex: upstream down/);
  assert.equal(out.trace.filter((e) => e.status === "error").length, 3, "codex, deepseek and backup were each tried");
});

test("formatAnswer: the answer comes first, then who ran and the cost; no list of idle roles", () => {
  const text = formatAnswer(
    { status: "ok", answer: "42, see a.js:1", notes: ["note one"], trace: [{ role: "researcher", label: "ask", key: "codex", provider: "router9", model: "codex-head", status: "ok", ms: 4200, tokensIn: 900, tokensOut: 60 }] },
    "9.9.9", { thisTask: 0.0123 }, "http://127.0.0.1:8787",
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "david_ask: ok");
  assert.ok(text.indexOf("42, see a.js:1") < text.indexOf("Who ran:"));
  assert.match(text, /- ask -> router9\/codex-head \[codex\] 4\.2s/);
  assert.ok(!/not called/.test(text));
  assert.match(text, /Notes:\n- note one/);
  assert.match(text, /Cost: \$0\.0123 this task/);
  assert.match(text, /Live: http:\/\/127\.0\.0\.1:8787/);
  assert.match(text, /Plugin: david plugin 9\.9\.9$/);
  assert.match(formatAnswer({ status: "awaiting_human", answer: "", notes: [], trace: [] }, null, null), /\(no answer\)/);
});

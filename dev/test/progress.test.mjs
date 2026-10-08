import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createProgress, decodeFrom, findSessionFile, frameStarts, summarise } from "../../plugin/david-plugin/lib/progress.js";

// The child session file is one zstd frame per appended event, so the tests build exactly that:
// frame(text) is one appended event, and every test asserts on what a poll would have produced.
const frame = (text) => zstdCompressSync(Buffer.from(text));
const frames = (...texts) => Buffer.concat(texts.map(frame));
const jsonl = (...objs) => objs.map((o) => `${JSON.stringify(o)}\n`).join("");

const tmp = () => mkdtempSync(join(tmpdir(), "david-prog-"));

test("progress: frameStarts finds every appended frame", () => {
  const buf = frames('{"a":1}\n', '{"b":2}\n', '{"c":3}\n');
  assert.equal(frameStarts(buf).length, 3);
});

test("progress: decodeFrom reads only complete frames and resumes where it stopped", () => {
  const complete = frames('{"n":1}\n', '{"n":2}\n', '{"n":3}\n');
  const partial = frame('{"n":4}\n').subarray(0, 12); // a child caught mid-append
  const buf = Buffer.concat([complete, partial]);

  const first = decodeFrom(buf, 0);
  assert.equal(first.text, '{"n":1}\n{"n":2}\n{"n":3}\n');
  assert.equal(first.offset, complete.length); // never past the half-written frame

  const again = decodeFrom(buf, first.offset);
  assert.equal(again.text, ""); // nothing new is invented while the frame is incomplete
  assert.equal(again.offset, complete.length);

  const finished = Buffer.concat([buf, frame('{"n":4}\n').subarray(12)]);
  const last = decodeFrom(finished, first.offset);
  assert.equal(last.text, '{"n":4}\n');
  assert.equal(last.offset, finished.length);
});

test("progress: a plain (uncompressed) session file still reads", () => {
  const buf = Buffer.from('{"n":1}\n{"n":2}\n');
  const one = decodeFrom(buf, 0);
  assert.equal(one.text, '{"n":1}\n{"n":2}\n');
  assert.equal(decodeFrom(buf, one.offset).text, "");
});

test("progress: events become labelled lines (nghĩ / nói / gọi / kết)", () => {
  const ctx = { calls: new Map() };
  // Real shape: the message sits under data.message, not data.content (the old reader never saw it).
  const msg = (...content) => ({ type: "assistant/message", data: { turn: 1, step: 2, message: { role: "assistant", content } } });
  assert.deepEqual(
    summarise(msg({ type: "reasoning", text: "Checking   config.js\nfor the retry cap" }, { type: "text", text: "Đang sửa config.js" }), {}, ctx).map((x) => [x.kind, x.text]),
    [["nghĩ", "Checking config.js for the retry cap"], ["nói", "Đang sửa config.js"]],
  );
  // The pre-0.7.7 flat shape still reads.
  assert.equal(summarise({ type: "assistant/message", data: { content: [{ type: "text", text: "flat" }] } })[0].text, "flat");
  // A long thought is one bounded line plus the full text (capped) as detail.
  const long = summarise(msg({ type: "reasoning", text: "x".repeat(5000) }), { maxChars: 40, detailChars: 300 })[0];
  assert.ok(long.text.length <= 40 && long.detail.length <= 300 && long.detail.length > 100);
  // A short single-line thought needs no detail.
  assert.equal(summarise(msg({ type: "reasoning", text: "short" }))[0].detail, undefined);

  const call = summarise({ type: "tool/call", data: { callId: "c1", name: "bash", arguments: '{"command":"cd /r && npm test"}' } }, {}, ctx)[0];
  assert.equal(call.kind, "gọi");
  assert.equal(call.text, 'bash {"command":"cd /r && npm test"}');
  assert.equal(ctx.calls.get("c1"), "bash");

  const res = (text, id = "c1") => summarise({ type: "tool/result", data: { message: { toolCallId: id, content: [{ type: "text", text }] } } }, {}, ctx);
  assert.deepEqual(res("pass 3\n[exit code: 0]").map((x) => [x.kind, x.text]), [["kết", "bash exit 0: pass 3 [exit code: 0]"]]);
  assert.match(res("not ok 1\n[exit code: 1]")[0].text, /^bash exit 1:/);
  assert.match(res("Error: ENOENT no such file")[0].text, /^bash lỗi:/);
  assert.match(res("<path>/x/a.js</path>\n<content>\n1: a\n</content>")[0].text, /^bash ok: \/x\/a\.js · \d+ dòng$/);
  assert.ok(res("a\nb\nc")[0].detail.includes("c"), "multi-line output keeps its full text as detail");
  // progress.results=false: calls and thoughts only, no results ...
  assert.deepEqual(summarise({ type: "tool/result", data: { message: { content: [{ type: "text", text: "ok" }] } } }, { results: false }), []);
  // ... except a sandbox refusal, which is never hidden.
  assert.match(summarise({ type: "tool/result", data: { message: { content: [{ type: "text", text: "[sandbox: file access denied under workspace-write mode]" }] } } }, { results: false })[0].text, /^⚠ .*file access denied/);
  // regression: reading a file that merely mentions the phrase must not raise the alarm
  assert.ok(!res("<path>/x/progress.js</path> <content> 1: /" + "a".repeat(5400) + "file access denied|policy denial")[0].text.startsWith("⚠"));
  assert.ok(!res("x".repeat(500) + " operation not permitted")[0].text.startsWith("⚠"));
  assert.ok(res("bash: /etc/x: Operation not permitted")[0].text.startsWith("⚠"));

  // Upstream trouble and permission asks are visible too.
  assert.deepEqual(summarise({ type: "llm/retry", data: { retry: 2, maxRetries: 5, failure: { code: "EMPTY_RESPONSE", message: "model returned no content" } } }).map((x) => [x.kind, x.text]), [["retry", "retry 2/5 EMPTY_RESPONSE: model returned no content"]]);
  assert.equal(summarise({ type: "turn/end", data: { turn: 3, reason: { kind: "error", error: { code: "SERVER", message: "500" } } } })[0].kind, "lỗi");
  assert.deepEqual(summarise({ type: "turn/end", data: { turn: 3, reason: { kind: "stop" } } }), []);
  assert.match(summarise({ type: "approval/asked", data: { toolName: "bash", reason: "escalate sandbox" } })[0].text, /^xin quyền bash: escalate sandbox/);
  assert.deepEqual(summarise({ type: "step/start", data: {} }), []);
});

test("progress: findSessionFile finds the child by session id under any project dir", () => {
  const root = tmp();
  const id = "c4785e7c-9eec-4c83-9a61-8b3fa12a16b1";
  mkdirSync(join(root, "--Users-someone-repo--", id), { recursive: true });
  writeFileSync(join(root, "--Users-someone-repo--", id, "session.v4.jsonl.zstd"), frames('{"n":1}\n'));
  assert.ok(findSessionFile(root, id)?.endsWith(join(id, "session.v4.jsonl.zstd")));
  assert.equal(findSessionFile(root, "does-not-exist"), null);
});

test("progress: a watching feed emits each child event once, and stops when told", () => {
  const root = tmp();
  const id = "aaaaaaaa-1111-2222-3333-444444444444";
  const dir = join(root, "--proj--", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, frames(jsonl({ type: "turn/start", data: {} }, { type: "tool/call", data: { name: "read", arguments: "{}" } })));

  const lines = [];
  const write = (text, extra) => lines.push({ text, ...extra });
  // pollMs is long on purpose: the test drives the poll itself, so nothing races the assertions.
  const progress = createProgress({ sessionsDir: root, pollMs: 60_000, heartbeatMs: 60_000 }, {});
  const feed = progress.watch({ sessionId: id, label: "worker-1", role: "worker", route: "deepseek", runId: "run1", write });

  feed.tick();
  assert.deepEqual(lines.map((l) => l.text), ['read {}']);
  assert.equal(lines[0].label, "worker-1");
  assert.equal(lines[0].route, "deepseek");
  assert.equal(lines[0].child, true);

  feed.tick(); // nothing appended: the same event must not be repeated
  assert.equal(lines.length, 1);

  writeFileSync(file, Buffer.concat([readFileSync(file), frame(jsonl({ type: "assistant/message", data: { content: [{ type: "text", text: "xong" }] } }))]));
  feed.tick();
  assert.deepEqual(lines.map((l) => l.text), ['read {}', "xong"]);

  feed.stop();
  writeFileSync(file, Buffer.concat([readFileSync(file), frame(jsonl({ type: "assistant/message", data: { content: [{ type: "text", text: "sau khi stop" }] } }))]));
  feed.tick();
  assert.equal(lines.length, 2); // a stopped feed stays stopped
});

test("progress: the watcher writes kind and detail with each line, and matches a result to its call", () => {
  const root = tmp();
  const id = "bbbbbbbb-1111-2222-3333-444444444444";
  mkdirSync(join(root, "--proj--", id), { recursive: true });
  const file = join(root, "--proj--", id, "session.v4.jsonl.zstd");
  const m = (...content) => ({ type: "assistant/message", data: { message: { role: "assistant", content } } });
  writeFileSync(file, frames(jsonl(
    m({ type: "reasoning", text: "Need to see why the test is red.\nCheck exit code first." }),
    { type: "tool/call", data: { callId: "k1", name: "bash", arguments: '{"command":"npm test"}' } },
    { type: "tool/result", data: { message: { toolCallId: "k1", content: [{ type: "text", text: "FAIL a.test.js\n[exit code: 1]" }] } } },
  )));
  const lines = [];
  const progress = createProgress({ sessionsDir: root, pollMs: 60_000, heartbeatMs: 60_000 }, {});
  progress.watch({ sessionId: id, label: "worker-1", role: "worker", route: "deepseek", runId: "r", write: (text, extra) => lines.push({ text, ...extra }) }).tick();
  assert.deepEqual(lines.map((l) => l.kind), ["nghĩ", "gọi", "kết"]);
  assert.ok(lines[0].detail.includes("Check exit code first"), "the full thought is kept as detail");
  assert.equal(lines[1].detail, "$ npm test");
  assert.match(lines[2].text, /^bash exit 1: FAIL a\.test\.js/);
  assert.ok(lines.every((l) => l.child === true && l.label === "worker-1"));

  // progress.results: false drops what a call returned, keeps the rest.
  const quiet = [];
  createProgress({ sessionsDir: root, pollMs: 60_000, heartbeatMs: 60_000, results: false }, {})
    .watch({ sessionId: id, label: "w", role: "worker", runId: "r", write: (text, extra) => quiet.push({ text, ...extra }) }).tick();
  assert.deepEqual(quiet.map((l) => l.kind), ["nghĩ", "gọi"]);
});

test("progress: a silent child still gets a heartbeat line", async () => {
  const root = tmp();
  const id = "bbbbbbbb-1111-2222-3333-444444444444";
  const lines = [];
  const progress = createProgress({ sessionsDir: root, pollMs: 60_000, heartbeatMs: 5 }, {});
  const feed = progress.watch({ sessionId: id, label: "worker-1", role: "worker", route: "deepseek", runId: "run1", write: (t) => lines.push(t) });
  await new Promise((r) => setTimeout(r, 20));
  feed.tick(); // no session file on disk yet
  feed.stop();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /worker-1 vẫn chạy \d+s… \(chưa thấy session log\)/);
});

test("progress: disabled and session-less watchers are inert", () => {
  const lines = [];
  const write = (t) => lines.push(t);
  createProgress({ enabled: false, pollMs: 60_000 }, {}).watch({ sessionId: "x", write }).tick();
  createProgress({ sessionsDir: tmp(), pollMs: 60_000 }, {}).watch({ sessionId: "", write }).tick();
  createProgress({ sessionsDir: tmp(), pollMs: 60_000 }, {}).watch({ sessionId: "x" }).tick();
  assert.deepEqual(lines, []);
});

test("progress: usage() adds up the prompt-cache numbers of a finished child from its session file", () => {
  const root = tmp();
  const id = "cccccccc-1111-2222-3333-444444444444";
  mkdirSync(join(root, "--proj--", id), { recursive: true });
  const ev = (u) => JSON.stringify({ type: "assistant/message", data: { message: { role: "assistant" }, usage: u } });
  const other = JSON.stringify({ type: "tool/call", data: { name: "bash" } });
  writeFileSync(join(root, "--proj--", id, "session.v4.jsonl"), [
    ev({ inputTokens: 14000, cacheReadTokens: 0, outputTokens: 50 }), other,
    ev({ inputTokens: 300, cacheReadTokens: 14000, outputTokens: 60 }),
    ev({ inputTokens: 200, outputTokens: 70 }), // a provider that reports no cache field at all
    "{half a line",
  ].join("\n") + "\n");
  const progress = createProgress({ sessionsDir: root }, {});
  assert.deepEqual(progress.usage(id), { calls: 3, reported: 2, uncached: 14500, cached: 14000, output: 180 });
  const mute = "eeeeeeee-1111-2222-3333-444444444444";
  mkdirSync(join(root, "--proj--", mute), { recursive: true });
  writeFileSync(join(root, "--proj--", mute, "session.v4.jsonl"), [ev({ inputTokens: 9, outputTokens: 1 }), ev({ inputTokens: 9, outputTokens: 1 })].join("\n") + "\n");
  assert.equal(progress.usage(mute).reported, 0, "no call carried a cache field: the provider is silent, which is not the same as 0 hits");
  assert.equal(progress.usage("no-such-session"), null, "no file: no statistic, never an error");
  const empty = "dddddddd-1111-2222-3333-444444444444";
  mkdirSync(join(root, "--proj--", empty), { recursive: true });
  writeFileSync(join(root, "--proj--", empty, "session.v4.jsonl"), other + "\n");
  assert.equal(progress.usage(empty), null, "a session with no model call has nothing to report");
});

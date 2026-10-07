import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createProgress, decodeFrom, findSessionFile, frameStarts, summarise } from "../../plugin/jev-orchestrator/lib/progress.js";

// The child session file is one zstd frame per appended event, so the tests build exactly that:
// frame(text) is one appended event, and every test asserts on what a poll would have produced.
const frame = (text) => zstdCompressSync(Buffer.from(text));
const frames = (...texts) => Buffer.concat(texts.map(frame));
const jsonl = (...objs) => objs.map((o) => `${JSON.stringify(o)}\n`).join("");

const tmp = () => mkdtempSync(join(tmpdir(), "jev-prog-"));

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

test("progress: only interesting events become lines", () => {
  assert.equal(
    summarise({ type: "assistant/message", data: { content: [{ type: "text", text: "Đang sửa   config.js\nvà chạy test" }] } }),
    "Đang sửa config.js và chạy test",
  );
  assert.equal(
    summarise({ type: "tool/call", data: { name: "read", arguments: '{"file_path":"/tmp/x.js"}' } }, 60),
    'read {"file_path":"/tmp/x.js"}',
  );
  // A long message is truncated to one bounded line, not flooded.
  assert.ok(summarise({ type: "assistant/message", data: { content: [{ type: "text", text: "x".repeat(500) }] } }, 40).length <= 40);
  // Ordinary tool results are noise; a sandbox refusal is the one result worth a line.
  assert.equal(summarise({ type: "tool/result", data: { message: { content: [{ type: "text", text: "ok" }] } } }), null);
  assert.match(
    summarise({ type: "tool/result", data: { message: { content: [{ type: "text", text: "[sandbox: file access denied under workspace-write mode]" }] } } }),
    /file access denied/,
  );
  const res = (text) => summarise({ type: "tool/result", data: { message: { content: [{ type: "text", text }] } } });
  // regression: reading a file that merely mentions the phrase must not raise the alarm
  assert.equal(res("<path>/x/progress.js</path> <content> 1: /" + "a".repeat(5400) + "file access denied|policy denial"), null);
  assert.equal(res("x".repeat(500) + " operation not permitted"), null);
  assert.ok(res("bash: /etc/x: Operation not permitted").startsWith("⚠"));
  assert.equal(summarise({ type: "step/start", data: {} }), null);
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

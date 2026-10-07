// What the child is actually doing, while it is doing it.
//
// Why this exists: the Harness publishes only `subagent/start` and `subagent/end` for a child
// (lib/lifecycle.js in @deepseek-ai/dsh-subagent), so david_run could write a step line when a worker
// started and another when it finished — and nothing in between. On 2026-10-07 the owner watched a
// card say "đang chạy · 224s…" over a step feed that had been silent for four minutes and asked,
// correctly, why a run that says it is running returns no log. It was not broken: a child's whole
// session is on disk, one zstd frame per appended event, at
//
//   <sessionsDir>/<project-dir>/<sessionId>/session.v4.jsonl.zstd
//
// and `subagent/start`'s identity.id IS that sessionId. So the realtime feed was always available;
// nobody was reading it. This module reads it: it decodes the frames appended since the last poll and
// turns the interesting ones (assistant text, tool calls, sandbox refusals) into step lines, which the
// dashboard already streams to the browser over SSE. No model call, no HTTP, nothing to configure.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

// Zstandard frame magic, little-endian 0xFD2FB528.
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const expandHome = (p) => (typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Byte offsets of every zstd frame header in the buffer. Scanned from 0 each poll rather than
// remembered, because the file is append-only: a frame boundary can never move.
export function frameStarts(buf) {
  const starts = [];
  let i = buf.indexOf(FRAME_MAGIC, 0);
  while (i !== -1) {
    starts.push(i);
    i = buf.indexOf(FRAME_MAGIC, i + 4);
  }
  return starts;
}

// Decode every frame that is COMPLETE at or after `from`, and return the decoded text plus the
// byte offset to resume from. A frame is complete when another frame header follows it, so the
// trailing frame is only decoded once it decompresses: a child that is mid-append leaves a partial
// frame behind, and `offset` must not move past it or those events would be lost.
export function decodeFrom(buf, from = 0) {
  if (buf.length === 0 || from >= buf.length) return { text: "", offset: Math.min(from, buf.length) };
  // A session file that is not zstd (plain JSONL) is read as text; nothing to split.
  if (buf.length < 4 || !buf.subarray(0, 4).equals(FRAME_MAGIC)) {
    return { text: buf.subarray(from).toString("utf8"), offset: buf.length };
  }
  const starts = frameStarts(buf);
  let offset = from;
  let text = "";
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    if (start < offset) continue;
    const last = k === starts.length - 1;
    const end = last ? buf.length : starts[k + 1];
    let chunk;
    try {
      chunk = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch {
      break; // incomplete trailing frame — the next append finishes it
    }
    // "It decompressed" is NOT "it is complete": measured here, a frame cut to 12 bytes still
    // decodes (to `{"n`). Advancing past it would throw away the rest of that event when the child
    // finishes writing it. Every session event line ends with a newline, so a trailing frame that
    // does not end with one is held back until the next append completes it.
    if (last && !chunk.endsWith("\n")) break;
    text += chunk;
    offset = end;
  }
  return { text, offset };
}

const DENIAL_RE = /file access denied|operation not permitted|policy denial|blocked by (the )?sandbox/i;
const DENIAL_HEAD_CHARS = 120;

// What a session event means for a person watching, as a list of { kind, text, detail }:
//   nghĩ   the model's reasoning ("what is it checking?")   nói  its visible reply
//   gọi    a tool call (the command, the file)              kết  what that call returned
//   retry  the upstream failed and the Harness is retrying  lỗi  a turn that ended in error
//   duyệt  a request to leave the sandbox, and the answer
// `text` is one bounded line (maxChars); `detail` is the full content up to detailChars, present only
// when it says more than the line does, so the dashboard can expand a row on click.
// One event can yield two items (a message with reasoning AND text), hence a list; [] is noise.
// `ctx.calls` remembers callId -> tool name so a result can say which call it answers.
// Sandbox refusals stay the loudest "kết": they explain a child wandering.

function item(kind, full, maxChars, detailChars, lead = "") {
  const flat = oneLine(full);
  if (!flat && !lead) return null;
  const text = truncate(lead + flat, maxChars);
  const raw = String(full ?? "").trim();
  const detail = raw && (raw.length > flat.length || text.length < (lead + flat).length || /\n/.test(raw)) ? truncate(raw, detailChars) : undefined;
  return { kind, text, ...(detail ? { detail } : {}) };
}

const blocksOf = (d) => {
  const c = d.message?.content ?? d.content;
  return Array.isArray(c) ? c : [];
};

export function summarise(entry, opts = {}, ctx = {}) {
  const o = typeof opts === "number" ? { maxChars: opts } : opts;
  const max = o.maxChars ?? 180;
  const cap = o.detailChars ?? 1200;
  const d = entry?.data ?? {};
  const out = [];
  const push = (x) => { if (x) out.push(x); };

  if (entry?.type === "assistant/message") {
    const blocks = blocksOf(d);
    const join = (types, key) => blocks.filter((c) => types.includes(c?.type)).map((c) => c[key] ?? c.text ?? "").filter((t) => typeof t === "string" && t.trim()).join("\n");
    push(item("nghĩ", join(["reasoning", "thinking"], "text"), max, cap));
    push(item("nói", join(["text"], "text"), max, cap));
    return out;
  }
  if (entry?.type === "tool/call") {
    const name = d.name || d.tool || "tool";
    const raw = typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments ?? {});
    ctx.calls?.set(d.callId, name);
    let pretty = raw;
    try {
      const a = JSON.parse(raw);
      pretty = typeof a?.command === "string" ? `$ ${a.command}` : JSON.stringify(a, null, 1);
    } catch { /* not JSON: show it as sent */ }
    const line = truncate(`${name} ${oneLine(raw)}`, max);
    out.push({ kind: "gọi", text: line, ...(pretty !== line ? { detail: truncate(pretty, cap) } : {}) });
    return out;
  }
  if (entry?.type === "tool/result") {
    const content = d.message?.content ?? d.content;
    const raw = (Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : String(content ?? "")).trim();
    const flat = oneLine(raw);
    const name = ctx.calls?.get(d.message?.toolCallId ?? d.message?.source?.callId ?? d.toolCallId) ?? "tool";
    if (!/^<path>/.test(raw) && DENIAL_RE.test(flat.slice(0, DENIAL_HEAD_CHARS))) {
      push(item("kết", raw, max, cap, "⚠ "));
      return out;
    }
    if (o.results === false) return out;
    const exit = /\[exit code: (-?\d+)\]/.exec(raw);
    const failed = (exit && exit[1] !== "0") || /^(error|fail|traceback)/i.test(flat);
    const status = exit ? `exit ${exit[1]}` : failed ? "lỗi" : "ok";
    const file = /^<path>(.*?)<\/path>/.exec(raw);
    const head = file ? `${file[1]} · ${raw.split("\n").length} dòng` : flat;
    const x = item("kết", raw, max, cap, `${name} ${status}${head ? ": " : ""}`);
    if (x) { x.text = truncate(`${name} ${status}${head ? ": " + head : ""}`, max); if (!x.detail && raw.length > 0 && raw.length > x.text.length) x.detail = truncate(raw, cap); out.push(x); }
    return out;
  }
  if (entry?.type === "llm/retry") {
    const f = d.failure ?? {};
    push(item("retry", f.message ?? "", max, cap, `retry ${d.retry ?? "?"}/${d.maxRetries ?? "?"} ${f.code ? f.code + ": " : ""}`));
    return out;
  }
  if (entry?.type === "turn/end" && d.reason?.kind === "error") {
    const e = d.reason.error ?? {};
    push(item("lỗi", e.message ?? "", max, cap, `turn ${d.turn ?? "?"} ${e.code ? e.code + ": " : ""}`));
    return out;
  }
  if (entry?.type === "approval/asked") {
    push(item("duyệt", d.reason ?? "", max, cap, `xin quyền ${d.toolName ?? ""}: `));
    return out;
  }
  if (entry?.type === "approval/decided") {
    push(item("duyệt", d.outcome ?? "", max, cap, "quyền: "));
    return out;
  }
  return out;
}

// A child session lives under a project directory named after the parent's cwd, which this module
// has no business reconstructing (the escaping is the Harness's). The session id is a directory name
// one level down, so it is found by looking, not by guessing.
export function findSessionFile(sessionsDir, sessionId) {
  let projects;
  try {
    projects = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  for (const project of projects) {
    const dir = join(sessionsDir, project, sessionId);
    for (const name of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
      const file = join(dir, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

// `watch()` returns { stop, tick } — tick is exposed so a test can drive one poll without timers.
export function createProgress(cfg = {}, { log = () => {} } = {}) {
  const opts = {
    enabled: true,
    pollMs: 1000,
    heartbeatMs: 30_000,
    maxLineChars: 180,
    detailChars: 1200,
    results: true,
    sessionsDir: "~/.dsh/sessions",
    ...cfg,
  };
  const dir = expandHome(opts.sessionsDir);

  function watch({ sessionId, label = "child", role, route, runId, write, startedAt = Date.now() }) {
    if (opts.enabled === false || !sessionId || typeof write !== "function") return { stop() {}, tick() {} };
    const state = { file: null, offset: 0, lastEmitAt: Date.now(), stopped: false, missing: 0, calls: new Map() };
    const emit = (x) => {
      const { text, kind, detail } = typeof x === "string" ? { text: x } : x;
      state.lastEmitAt = Date.now();
      try {
        write(text, { role, label, route, run: runId, child: true, ...(kind ? { kind } : {}), ...(detail ? { detail } : {}) });
      } catch (err) {
        log(`progress: ${label} write failed: ${err.message || err}`);
      }
    };

    function tick() {
      if (state.stopped) return;
      const now = Date.now();
      try {
        if (!state.file) {
          state.file = findSessionFile(dir, sessionId);
          if (!state.file) state.missing += 1;
        }
        if (state.file) {
          const buf = readFileSync(state.file);
          const { text, offset } = decodeFrom(buf, state.offset);
          state.offset = offset;
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let entry;
            try {
              entry = JSON.parse(line);
            } catch {
              continue; // a half-written line is the next poll's problem
            }
            for (const x of summarise(entry, { maxChars: opts.maxLineChars, detailChars: opts.detailChars, results: opts.results }, state)) emit(x);
          }
        }
        // Silence is the thing the owner complained about, so a quiet child still gets a line.
        if (now - state.lastEmitAt >= opts.heartbeatMs) {
          const secs = Math.round((now - startedAt) / 1000);
          emit({ kind: "nhịp", text: state.file ? `${label} vẫn chạy ${secs}s…` : `${label} vẫn chạy ${secs}s… (chưa thấy session log)` });
        }
      } catch (err) {
        log(`progress: ${label} watch failed: ${err.message || err}`); // never kill a run over the feed
      }
    }

    const timer = setInterval(tick, Math.max(25, opts.pollMs));
    timer.unref?.(); // the feed must never hold the process open
    return {
      tick,
      stop() {
        state.stopped = true;
        clearInterval(timer);
      },
    };
  }

  return { watch, opts };
}

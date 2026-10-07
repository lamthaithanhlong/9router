// What the child is actually doing, while it is doing it.
//
// Why this exists: the Harness publishes only `subagent/start` and `subagent/end` for a child
// (lib/lifecycle.js in @deepseek-ai/dsh-subagent), so jev_run could write a step line when a worker
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

// One step line for a session event, or null when the event is noise. Kept deliberately narrow:
// the feed is for a human watching a run, and 37 tool results per task would drown the three lines
// that matter. Sandbox refusals are the exception — they are the one "result" that explains a child
// wandering, so they are surfaced.
export function summarise(entry, maxChars = 180) {
  const d = entry?.data ?? {};
  if (entry?.type === "assistant/message") {
    const text = (Array.isArray(d.content) ? d.content : [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join(" ");
    const t = oneLine(text);
    return t ? truncate(t, maxChars) : null;
  }
  if (entry?.type === "tool/call") {
    const name = d.name || d.tool || "tool";
    const args = typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments ?? {});
    return truncate(`${name} ${oneLine(args)}`, maxChars);
  }
  if (entry?.type === "tool/result") {
    const content = d.message?.content ?? d.content;
    const text = oneLine(Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join(" ") : content);
    // A real denial is the whole message, so the phrase sits in the first few dozen characters
    // (measured: 17-65). A file dump that merely mentions the phrase (this very file's regex) hits at
    // 5000+ and opens with <path>, so only the head is tested and dumps are skipped.
    const head = text.slice(0, DENIAL_HEAD_CHARS);
    return !/^<path>/.test(text) && DENIAL_RE.test(head) ? truncate(`⚠ ${text}`, maxChars) : null;
  }
  return null;
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
    sessionsDir: "~/.dsh/sessions",
    ...cfg,
  };
  const dir = expandHome(opts.sessionsDir);

  function watch({ sessionId, label = "child", role, route, runId, write, startedAt = Date.now() }) {
    if (opts.enabled === false || !sessionId || typeof write !== "function") return { stop() {}, tick() {} };
    const state = { file: null, offset: 0, lastEmitAt: Date.now(), stopped: false, missing: 0 };
    const emit = (text) => {
      state.lastEmitAt = Date.now();
      try {
        write(text, { role, label, route, run: runId, child: true });
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
            const summary = summarise(entry, opts.maxLineChars);
            if (summary) emit(summary);
          }
        }
        // Silence is the thing the owner complained about, so a quiet child still gets a line.
        if (now - state.lastEmitAt >= opts.heartbeatMs) {
          const secs = Math.round((now - startedAt) / 1000);
          emit(state.file ? `${label} vẫn chạy ${secs}s…` : `${label} vẫn chạy ${secs}s… (chưa thấy session log)`);
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

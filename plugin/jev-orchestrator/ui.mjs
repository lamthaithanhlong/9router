#!/usr/bin/env node
// Free, live HTML dashboard for jev_run. Dependency-free: only node:http, node:fs
// and (when 9Router's DB exists) node:sqlite, all read-only. The page is read
// from disk on every request so editing it never needs a restart. State comes
// from `lib/telemetry.js`, the same helper the CLI watcher and `jev_watch` use,
// so the page and the tool cannot disagree.
//
//   node ui.mjs              serve on 127.0.0.1:8787 (default)
//   node ui.mjs --port 9000  different port
//   node ui.mjs --poll 1000  step-tail poll interval (ms)
//   node ui.mjs --open       launch the default browser
//   node ui.mjs --once       print one snapshot and exit
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./lib/config.js";
import { readLedger, snapshotAsync, tailSteps } from "./lib/telemetry.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const flagVal = (n, def) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : def; };

const PORT = Number(flagVal("--port", "8787")) || 8787;
const POLL_MS = Number(flagVal("--poll", "1000")) || 1000;
const ONCE = flag("--once");
const OPEN = flag("--open");

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_FILE = join(HERE, "lib", "ui", "index.html");

// --- HTTP server: 127.0.0.1 only ----------------------------------------------
const cfg0 = resolveConfig({});
let _cfg = cfg0;
let _ledger = null;

function refreshLedger() { _ledger = readLedger(); }
refreshLedger();

const sseClients = new Set();
let stepOffset = 0;
let lastSeenRunId = null; // run lifecycle tracking for refreshing authoritative state

function broadcast(event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const res of sseClients) {
    try { res.write(`event: ${event}\ndata: ${payload}\n\n`); } catch { sseClients.delete(res); }
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let body = "";
      try { body = readFileSync(HTML_FILE, "utf8"); } catch { res.writeHead(502); res.end("ui.html missing"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (url.pathname === "/state") {
      const snap = await snapshotAsync(_cfg, _ledger);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(snap));
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "connection": "keep-alive",
        // Disable any proxy buffering so SSE reaches the browser immediately.
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => { sseClients.delete(res); });
      // First frame: full snapshot, exactly like the spec.
      const snap = await snapshotAsync(_cfg, _ledger);
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      return;
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    try { res.writeHead(500).end(err.message); } catch { /* connection already gone */ }
  }
});

async function tick() {
  // Tail step file by byte offset; never re-read what we already saw.
  refreshLedger();
  const out = tailSteps(stepOffset);
  stepOffset = out.offset;
  // Detect run lifecycle change: a different runId in the stream means a new
  // run started. The dashboard needs an authoritative refresh in that case so
  // the previous run's final state stays on screen while new stages animate.
  for (const e of out.lines) {
    broadcast("step", e);
    if (e && e.run && e.run !== lastSeenRunId) {
      lastSeenRunId = e.run;
      try { broadcast("snapshot", await snapshotAsync(_cfg, _ledger)); } catch { /* the next tick will retry */ }
    }
  }
}

const URL_STR = `http://127.0.0.1:${PORT}/`;

if (ONCE) {
  const snap = await snapshotAsync(_cfg, _ledger);
  console.log(URL_STR);
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(URL_STR);
  if (OPEN) openBrowser(URL_STR);
});

const timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);

const heartbeat = setInterval(() => {
  for (const res of sseClients) {
    try { res.write(": ping\n\n"); } catch { sseClients.delete(res); }
  }
}, 15_000);

let shutting = false;
function shutdown() {
  if (shutting) return;
  shutting = true;
  clearInterval(timer);
  clearInterval(heartbeat);
  for (const res of sseClients) {
    try { res.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Tiny browser launcher: spawn open on macOS, xdg-open on Linux, rundll32 on
// Windows. Best-effort: a failure here must never break the server.
async function openBrowser(url) {
  const { spawn } = await import("node:child_process");
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "rundll32"
    : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const c = spawn(cmd, args, { stdio: "ignore", detached: true });
    c.on("error", () => {});
    c.unref();
  } catch { /* ignore */ }
}

export const __test__ = { server, getCfg: () => _cfg, broadcast, URL: URL_STR };
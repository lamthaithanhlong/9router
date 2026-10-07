// "Does this route actually answer?" — asked BEFORE a child is committed to it.
//
// The Cursor route through 9Router answers HTTP 200 with no text at all: an
// ERROR_NOT_LOGGED_IN carried inside the stream, which 9Router records as
// "[Empty streaming response]" and counts as a success. The pipeline already treats an
// empty reply as a failed route, but a child only finds that out after ~70s, and the run
// log shows `worker-1 ended with aborted` after 1638s — with the backup route that
// follows answering 14 tokens. So ask first, with a short timeout, and require the word
// PONG back rather than merely a 200.
//
// One probe is one small upstream call (a few hundred tokens), not an agent: no child is
// started, no tool filter is built, no prompt file is read.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ASK = "Reply with the single word: PONG";

let DatabaseSync = null;
let sqliteOk = false;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
  sqliteOk = true;
} catch {
  // No node:sqlite: the probe still works when ROUTER9_API_KEY is in the environment.
}

// `/v1/chat/completions` is 9Router's *proxy* endpoint: it wants the same bearer key a client
// sends, NOT the dashboard's x-9r-cli-token (measured: the CLI token answers HTTP 401 here).
// So resolve a real key: the Harness already holds one for this provider, and when it is not in
// the environment we read the active one out of 9Router's own database.
function activeApiKey(dbFile) {
  if (!sqliteOk || !dbFile) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    return db.prepare("SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1").get()?.key ?? null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* read-only handle */ }
  }
}

// Last resort for a dashboard-shaped endpoint; kept so a probe against a private 9Router with
// no API key configured still reports something other than a bare 401.
function cliToken(dataDir) {
  try {
    const raw = readFileSync(join(dataDir, "machine-id"), "utf8").trim();
    const secret = readFileSync(join(dataDir, "auth", "cli-secret"), "utf8").trim();
    return createHash("sha256").update(`${raw}9r-cli-auth${secret}`).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

const expandHome = (p) => (typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function createProbe(cfg, { log = () => {}, fetchImpl = fetch } = {}) {
  const c = cfg.probe ?? {};
  const baseUrl = String(c.baseUrl ?? "http://127.0.0.1:20128").replace(/\/+$/, "");
  const timeoutMs = Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 15_000;
  const ttlMs = Number(c.ttlMs) > 0 ? Number(c.ttlMs) : 300_000;
  // Never starve the answer. These are reasoning models and the thinking tokens are billed to the
  // same budget, so a small max_tokens truncates the visible text: measured on cursor-workers,
  // max_tokens 8 gave "" or "P", while 64 gave "PONG" every time with completion_tokens 33/30/11.
  const maxTokens = Number(c.maxTokens) >= 32 ? Number(c.maxTokens) : 256;
  const dataDir = expandHome(c.dataDir ?? "~/.9router");
  const keyDb = expandHome(c.dbFile ?? cfg.cost?.dbFile ?? "~/.9router/db/data.sqlite");
  const cache = new Map();
  let warnedNoAuth = false;

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    const envKey = process.env.ROUTER9_API_KEY;
    if (envKey) {
      headers.Authorization = `Bearer ${envKey}`;
      return headers;
    }
    const dbKey = activeApiKey(keyDb);
    if (dbKey) {
      headers.Authorization = `Bearer ${dbKey}`;
      return headers;
    }
    const token = cliToken(dataDir);
    if (token) {
      headers["x-9r-cli-token"] = token;
      if (!warnedNoAuth) { warnedNoAuth = true; log("probe found no API key; falling back to x-9r-cli-token, which /v1 refuses with 401"); }
    } else if (!warnedNoAuth) {
      warnedNoAuth = true;
      log(`probe has neither ROUTER9_API_KEY nor an active key in ${keyDb}; probes will be refused`);
    }
    return headers;
  }

  async function probe(routeKey) {
    const route = cfg.routes?.[routeKey];
    if (!route) return { ok: false, ms: 0, chars: 0, sample: "", reason: `unknown route ${routeKey}`, at: Date.now() };

    const hit = cache.get(routeKey);
    if (hit && Date.now() - hit.at < ttlMs) return hit;

    const at = Date.now();
    const out = { ok: false, ms: 0, chars: 0, sample: "", reason: "not probed", at };

    const t0 = Date.now();
    try {
      const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model: route.model, messages: [{ role: "user", content: ASK }], max_tokens: maxTokens, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      out.ms = Date.now() - t0;

      let content = "";
      try {
        const parsed = JSON.parse(body);
        content = parsed?.choices?.[0]?.message?.content ?? "";
        if (Array.isArray(content)) content = content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
        if (typeof content !== "string") content = "";
      } catch { /* an error page or an empty body: content stays "" */ }

      out.chars = content.length;
      out.sample = content.slice(0, 40);
      if (!res.ok) out.reason = `HTTP ${res.status}`;
      else if (/PONG/i.test(content)) { out.ok = true; out.reason = "PONG"; }
      else if (content.trim() === "") out.reason = `empty reply (HTTP ${res.status}, 0 chars)`;
      else out.reason = `unexpected reply (HTTP ${res.status}): ${out.sample}`;
    } catch (err) {
      out.ms = Date.now() - t0;
      const name = err?.name ?? "";
      out.reason = name === "TimeoutError" || /abort/i.test(String(err?.message ?? ""))
        ? `no answer within ${timeoutMs}ms`
        : `probe failed: ${err?.message ?? err}`;
    }

    cache.set(routeKey, out);
    if (!out.ok) log(`probe ${routeKey}: ${out.reason}`);
    return out;
  }

  // Every route that the pipeline must ask about before using it.
  function probedRouteKeys() {
    return Object.keys(cfg.routes ?? {}).filter((k) => cfg.routes[k]?.probe === true);
  }

  function forget(routeKey) {
    if (routeKey === undefined) cache.clear();
    else cache.delete(routeKey);
  }

  return { probe, probedRouteKeys, forget };
}

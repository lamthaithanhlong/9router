import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { expandHome } from "./config.js";
import { resolveSecret } from "./keys.js";

const MAX_STATE_CHARS = 40_000; // laya-serve refuses a state over 50 000

// True when the text is plain English: under 2% of its letters fall outside ASCII.
// Vietnamese, with its diacritics, is well above that.
export function looksEnglish(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const outside = letters.filter((c) => c.charCodeAt(0) > 127).length;
  return outside / letters.length < 0.02;
}

// Only a loopback URL may have a local server started for it. A cloud URL that
// fails must fall through, not spawn laya-ctl on this machine.
export function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

// Client for System One (Jev). Two sources, tried in order:
//   1. the configured `url` with a key (TypeSafe cloud, metered by the ledger), and
//   2. the free local laya-serve at `fallbackUrl` when no key resolves or the
//      cloud call fails.
// Every failure returns null so the caller falls back to its rules; a down Jev
// never blocks a run. When the LOCAL source is unreachable it is started in the
// background (laya-ctl start), at most once per cooldown.
export function createLaya(cfg, { fetchImpl = globalThis.fetch, spawnImpl = spawn, log = () => {}, now = Date.now, env = process.env, readFile } = {}) {
  let lastStart = -Infinity;

  function ensureUp(url) {
    if (!isLoopback(url)) return;
    const ctl = expandHome(cfg.ctl ?? "");
    if (!ctl || !existsSync(ctl) || now() - lastStart < cfg.restartCooldownMs) return;
    lastStart = now();
    log(`laya unreachable: starting it in the background (${ctl} start)`);
    try {
      spawnImpl(ctl, ["start"], { detached: true, stdio: "ignore" }).unref();
    } catch (err) {
      log(`laya start failed: ${err.message}`);
    }
  }

  async function callOnce({ url, key }, id, state, instructions) {
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetchImpl(`${url}/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        state: state.slice(0, MAX_STATE_CHARS),
        // Only send `model` where a hosted endpoint expects it; laya-serve does not.
        ...(key && cfg.model ? { model: cfg.model } : {}),
        questions: { [id]: { type: "noul", instructions } },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const answer = payload?.answers?.[id];
    if (answer?.type !== "noul" || typeof answer.noul !== "number") throw new Error("no noul answer");
    const inputTokens = Number.isFinite(payload?.usage?.input_tokens) ? payload.usage.input_tokens : 0;
    return { value: answer.noul, inputTokens };
  }

  // Probability (0..1) that the answer to a yes/no question is yes, or null.
  // `onUsage` receives {inputTokens, model, source} for the call that answered.
  // `opts.cloud === false` skips the hosted endpoint entirely: the caller uses it
  // when the day's paid quota is gone, so the free local engine keeps answering
  // instead of the run losing its Jev answer altogether.
  async function noul(id, state, instructions, onUsage, opts = {}) {
    if (!cfg.enabled) return null;
    const secret = opts.cloud === false ? null : resolveSecret({ keyEnv: cfg.keyEnv, keyFile: cfg.keyFile }, { env, readFile });
    const attempts = secret
      ? [{ url: cfg.url, key: secret.value }, ...(cfg.fallbackUrl ? [{ url: cfg.fallbackUrl, key: null }] : [])]
      : [{ url: cfg.fallbackUrl || cfg.url, key: null }];

    for (const attempt of attempts) {
      try {
        const out = await callOnce(attempt, id, state, instructions);
        // The local engine never receives `model`, so the trace must not claim one.
        if (typeof onUsage === "function") onUsage({ inputTokens: out.inputTokens, model: attempt.key ? cfg.model : null, source: attempt.key ? "cloud" : "local" });
        return out.value;
      } catch (err) {
        log(`laya ${id} (${attempt.key ? "cloud" : "local"}): ${err.message}`);
        ensureUp(attempt.url);
      }
    }
    return null;
  }

  return { noul };
}

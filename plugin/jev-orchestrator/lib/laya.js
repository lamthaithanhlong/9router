import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { expandHome } from "./config.js";

const MAX_STATE_CHARS = 40_000; // laya-serve refuses a state over 50 000

// True when the text is plain English: under 2% of its letters fall outside ASCII.
// Vietnamese, with its diacritics, is well above that.
export function looksEnglish(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const outside = letters.filter((c) => c.charCodeAt(0) > 127).length;
  return outside / letters.length < 0.02;
}

// Client for laya-serve's /v1/systemone. Every failure returns null so the
// caller falls back to its rules; a down Laya never blocks a run. When the
// server is unreachable it is started in the background (laya-ctl start),
// at most once per cooldown.
export function createLaya(cfg, { fetchImpl = globalThis.fetch, spawnImpl = spawn, log = () => {}, now = Date.now } = {}) {
  let lastStart = -Infinity;

  function ensureUp() {
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

  // Probability (0..1) that the answer to a yes/no question is yes, or null.
  async function noul(id, state, instructions) {
    if (!cfg.enabled) return null;
    try {
      const res = await fetchImpl(`${cfg.url}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: state.slice(0, MAX_STATE_CHARS),
          questions: { [id]: { type: "noul", instructions } },
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const answer = (await res.json())?.answers?.[id];
      if (answer?.type !== "noul" || typeof answer.noul !== "number") throw new Error("no noul answer");
      return answer.noul;
    } catch (err) {
      log(`laya ${id}: ${err.message}`);
      ensureUp();
      return null;
    }
  }

  return { noul };
}

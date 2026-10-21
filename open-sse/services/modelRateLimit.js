// A pace for the models whose upstream cannot keep up (owner, 2026-10-21: "nên đặt rate limit mỗi khi gọi deepseek lại gọi quá
// nhanh deepseek ratelimit chạy ko kịp").
//
// Measured in this router's own log (requestDetails, 2026-10-21 06:33-06:44 UTC): four acceptance judges and the lore graph build
// sent ~50 DeepSeek requests a minute; 156 of them (about 35%) came back 503 "No available channel for model deepseek-v4-flash
// under group kimi (distributor)", and each 503 also put that connection on a 30 s cooldown, so the next callers failed too.
// Every caller (Claude's workers, the Risu app, test harnesses) goes through this one process, so a limit kept HERE is shared by
// all of them; a limit in each caller would let N callers send N times the pace.
//
// A rule: { match, concurrency, rpm, maxWaitMs }. `match` is a case-insensitive substring of "provider/model". At most
// `concurrency` requests run at once and starts are spaced 60000/rpm ms apart; the others wait in arrival order (FIFO). A request
// that would wait longer than maxWaitMs is answered 429 with Retry-After instead, so a caller backs off rather than hanging.
// The slot is held until the upstream call returns (for a streamed answer: until its headers; DeepSeek workers do not stream).
// settings.modelRateLimits (an array of rules) replaces the defaults; an empty array turns the pace off.

export const DEFAULT_RATE_LIMITS = [{ match: "deepseek", concurrency: 4, rpm: 30, maxWaitMs: 180000 }];

const states = new Map();

/** the rule for this provider/model, or null */
export function rateRuleFor(settings, provider, model) {
  const rules = Array.isArray(settings?.modelRateLimits) ? settings.modelRateLimits : DEFAULT_RATE_LIMITS;
  const name = `${provider}/${model}`.toLowerCase();
  const rule = rules.find((r) => r && typeof r.match === "string" && r.match && name.includes(r.match.toLowerCase()));
  if (!rule) return null;
  return {
    match: rule.match.toLowerCase(),
    concurrency: Math.max(1, Number(rule.concurrency) || 1),
    rpm: Math.max(0, Number(rule.rpm) || 0),
    maxWaitMs: Math.max(0, Number(rule.maxWaitMs ?? 180000)),
  };
}

function stateOf(rule) {
  let s = states.get(rule.match);
  if (!s) {
    s = { active: 0, nextStart: 0, queue: [], timer: null };
    states.set(rule.match, s);
  }
  return s;
}

function pump(rule, s, clock) {
  if (s.timer) return;
  while (s.queue.length && s.active < rule.concurrency) {
    const now = clock.now();
    const wait = s.nextStart - now;
    if (wait > 0) {
      s.timer = clock.setTimeout(() => { s.timer = null; pump(rule, s, clock); }, wait);
      return;
    }
    const w = s.queue.shift();
    clock.clearTimeout(w.deadline);
    s.active++;
    s.nextStart = now + (rule.rpm ? 60000 / rule.rpm : 0);
    let released = false;
    w.resolve(() => {
      if (released) return;
      released = true;
      s.active--;
      pump(rule, s, clock);
    });
  }
}

/**
 * Waits for a slot. Resolves to release() (call it once the upstream call returned, success or not), or rejects with
 * {rateLimited: true, retryAfterMs} when the wait would pass rule.maxWaitMs.
 */
export function acquireSlot(rule, clock = { now: Date.now, setTimeout, clearTimeout }) {
  const s = stateOf(rule);
  return new Promise((resolve, reject) => {
    const w = { resolve, deadline: null };
    w.deadline = clock.setTimeout(() => {
      const i = s.queue.indexOf(w);
      if (i >= 0) s.queue.splice(i, 1);
      const err = new Error(`rate limit: waited ${rule.maxWaitMs} ms for a ${rule.match} slot`);
      err.rateLimited = true;
      err.retryAfterMs = Math.max(1000, (rule.rpm ? 60000 / rule.rpm : 1000) * (s.queue.length + 1));
      reject(err);
    }, rule.maxWaitMs);
    s.queue.push(w);
    pump(rule, s, clock);
  });
}

/** what the pace holds now, for the log and tests */
export function rateLimitState(match) {
  const s = states.get(String(match).toLowerCase());
  return s ? { active: s.active, waiting: s.queue.length } : { active: 0, waiting: 0 };
}

/** tests only */
export function _resetRateLimits() {
  for (const s of states.values()) if (s.timer) clearTimeout(s.timer);
  states.clear();
}

// The router paces DeepSeek for every caller at once (open-sse/services/modelRateLimit.js). Measured 2026-10-21: ~50 requests a
// minute from four test judges and a graph build got 35% "503 No available channel"; each 503 also cooled the connection for 30 s.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateRuleFor, acquireSlot, rateLimitState, _resetRateLimits, DEFAULT_RATE_LIMITS } from "../../open-sse/services/modelRateLimit.js";

const clock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };

describe("modelRateLimit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); _resetRateLimits(); });
  afterEach(() => { _resetRateLimits(); vi.useRealTimers(); });

  it("finds the rule by model name; settings replace the defaults; an empty list turns it off", () => {
    expect(rateRuleFor({}, "openai-compatible-chat-8ec45c8c", "deepseek-v4-flash")).toMatchObject({ match: "deepseek", concurrency: 4, rpm: 30 });
    expect(rateRuleFor({}, "cx", "gpt-6-luna")).toBeNull();
    expect(rateRuleFor({ modelRateLimits: [{ match: "kimi", concurrency: 2, rpm: 10 }] }, "mvn", "kimi-k3")).toMatchObject({ concurrency: 2, rpm: 10 });
    expect(rateRuleFor({ modelRateLimits: [] }, "x", "deepseek-v4-flash")).toBeNull();
    expect(DEFAULT_RATE_LIMITS[0].match).toBe("deepseek");
  });

  it("never runs more than `concurrency` at once, and starts them 60000/rpm ms apart, in arrival order", async () => {
    const rule = { match: "t1", concurrency: 2, rpm: 60, maxWaitMs: 600000 };
    const started = [];
    const releases = [];
    for (let i = 0; i < 5; i++) acquireSlot(rule, clock).then((rel) => { started.push([i, Date.now()]); releases.push(rel); });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([[0, 0]]);                       // the second waits for the spacing, not for a free slot
    await vi.advanceTimersByTimeAsync(1000);
    expect(started.map((s) => s[0])).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(started.length).toBe(2);                          // both slots busy: the third waits however long it takes
    expect(rateLimitState("t1")).toEqual({ active: 2, waiting: 3 });
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(started.map((s) => s[0])).toEqual([0, 1, 2]);
    releases[1](); releases[1]();                            // a second release of the same slot does nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(started.map((s) => s[0])).toEqual([0, 1, 2]);     // spacing: 3 may start only 1 s after 2
    await vi.advanceTimersByTimeAsync(1000);
    expect(started.map((s) => s[0])).toEqual([0, 1, 2, 3]);
    expect(rateLimitState("t1").active).toBe(2);
  });

  it("a request that would wait past maxWaitMs is refused (429 upstream of it), and the queue moves on", async () => {
    const rule = { match: "t2", concurrency: 1, rpm: 0, maxWaitMs: 2000 };
    const rel = await acquireSlot(rule, clock);
    const late = acquireSlot(rule, clock);
    const err = late.catch((e) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await err).toMatchObject({ rateLimited: true });
    expect((await err).retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(rateLimitState("t2")).toEqual({ active: 1, waiting: 0 });
    rel();
    const next = await acquireSlot(rule, clock);
    expect(rateLimitState("t2").active).toBe(1);
    next();
  });

  it("models of one rule share one pace (deepseek-v4-flash and deepseek-v4.1-flash)", async () => {
    const a = rateRuleFor({}, "p", "deepseek-v4-flash");
    const b = rateRuleFor({}, "p", "deepseek-v4.1-flash");
    const rels = [];
    for (let i = 0; i < 4; i++) rels.push(await (async () => { const p = acquireSlot(i % 2 ? a : b, clock); await vi.advanceTimersByTimeAsync(2000); return p; })());
    let fifth = false;
    acquireSlot(a, clock).then(() => { fifth = true; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(fifth).toBe(false);                               // 4 running across both models: the fifth waits
    rels[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(fifth).toBe(true);
  });
});

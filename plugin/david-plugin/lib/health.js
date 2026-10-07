// Remembers, in memory, which routes just failed so later calls skip them for a while.
export class RouteHealth {
  constructor(cooldownMs, now = Date.now) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.until = new Map();
  }

  fail(key) {
    this.until.set(key, this.now() + this.cooldownMs);
  }

  ok(key) {
    this.until.delete(key);
  }

  cooling(key) {
    const u = this.until.get(key);
    return u !== undefined && this.now() < u;
  }
}

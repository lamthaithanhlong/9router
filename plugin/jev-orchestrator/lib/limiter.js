// Caps how many children run at once on one upstream, and spaces their starts out, so a burst of
// workers cannot hammer a rate-limited account (Cursor rate-limited the owner after unbounded fan-out).
// Routes that share an upstream share a `group` (cursor-workers and manager-temp are both Cursor).
// One instance serves every jev_run in the process, so two simultaneous runs share the same cap.
export class Limiter {
  constructor({ limits = {}, gaps = {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.limits = limits; // group -> max concurrent children (absent = unlimited)
    this.gaps = gaps; // group -> minimum ms between two child starts
    this.now = now;
    this.sleep = sleep;
    this.groups = new Map();
  }

  state(group) {
    if (!this.groups.has(group)) this.groups.set(group, { active: 0, waiters: [], nextStart: 0 });
    return this.groups.get(group);
  }

  // Resolves with a release function once a slot is free and the start gap has passed.
  async acquire(group) {
    const st = this.state(group);
    const max = this.limits[group];
    const asked = this.now();
    if (max !== undefined) {
      while (st.active >= max) await new Promise((resolve) => st.waiters.push(resolve));
    }
    st.active++;
    const gap = this.gaps[group] ?? 0;
    if (gap > 0) {
      const startAt = Math.max(this.now(), st.nextStart); // reserve the slot before sleeping
      st.nextStart = startAt + gap;
      const wait = startAt - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      st.active--;
      st.waiters.shift()?.();
    };
    release.queuedMs = this.now() - asked;
    return release;
  }

  active(group) {
    return this.state(group).active;
  }
}

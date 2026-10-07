import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const utcDay = () => new Date().toISOString().slice(0, 10);

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Daily spend per route, persisted so a restart does not reset the day. One
// process owns the file; there is no cross-process locking.
export class Ledger {
  constructor(file, budgets, today = utcDay) {
    this.file = file;
    this.budgets = budgets;
    this.today = today;
  }

  load() {
    const fresh = { day: this.today(), used: {} };
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      return saved.day === fresh.day ? saved : fresh;
    } catch {
      return fresh; // missing or corrupt: start the day at zero
    }
  }

  save(state) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(state));
  }

  // Tokens for token-metered routes, 1 for call-metered routes.
  units(key, tokens) {
    return this.budgets[key]?.unit === "calls" ? 1 : tokens;
  }

  used(key) {
    return this.load().used[key] ?? 0;
  }

  remaining(key) {
    const b = this.budgets[key];
    return b ? b.daily - this.used(key) : Number.POSITIVE_INFINITY;
  }

  canSpend(key, tokens, role) {
    const b = this.budgets[key];
    if (!b) return true;
    const after = this.remaining(key) - this.units(key, tokens);
    const floor = b.reserveFor.includes(role) ? 0 : b.daily * b.reserveFraction;
    return after >= floor;
  }

  charge(key, tokens) {
    if (!this.budgets[key]) return;
    const state = this.load();
    state.used[key] = (state.used[key] ?? 0) + this.units(key, tokens);
    this.save(state);
  }
}

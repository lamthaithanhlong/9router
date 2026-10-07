// A route definition is normally a model we can call. It can also be a SEAT: `{ rotate: [keys] }`.
// A seat is an office, not a model. The `manager` office is held alternately by Codex and
// DeepSeek-host, so neither one's quota nor its wallet decides the job alone. Round-robin is
// deliberate: "codex first, deepseek when codex is out" is priority, a different thing, and the
// owner rejected it.
export function isSeat(def) {
  return Array.isArray(def?.rotate) && def.rotate.length > 0;
}

// Which member holds the seat on this call, or null when nobody can take it. `rotation` is the
// process-wide counter store (a Map, or any object with get/set). A member that cannot work is
// stepped over, and the counter advances past it, so the alternation is not disturbed: if Codex is
// skipped on its turn, DeepSeek covers that turn and the next call goes back to Codex.
export function pickSeatMember(seatKey, cfg, ledger, tokens, { skip = [], health, rotation, role } = {}) {
  const members = cfg.routes[seatKey]?.rotate ?? [];
  const store = rotation ?? new Map();
  const read = () => Number((typeof store.get === "function" ? store.get(seatKey) : store[seatKey]) ?? 0) || 0;
  const write = (n) => { if (typeof store.set === "function") store.set(seatKey, n); else store[seatKey] = n; };
  const turn = read();
  const eligible = (key) => {
    const def = cfg.routes[key];
    if (!def || isSeat(def)) return false;
    if (skip.includes(key)) return false;
    if (health?.cooling(key)) return false;
    return ledger.canSpend(key, tokens, role ?? seatKey);
  };
  for (let n = 0; n < members.length; n += 1) {
    const key = members[(turn + n) % members.length];
    if (!eligible(key)) continue;
    const next = turn + n + 1;
    write(next);
    return { key, turn: next, def: cfg.routes[key] };
  }
  return null;
}

// First entry on the role's chain that can take the work: it exists, it was not failed in this call
// (`skip`), and the ledger can afford it. A seat entry is offered only if one of its members is
// eligible. If every candidate is cooling down after a recent failure, the cooldown is ignored and
// the chain is tried in order again. `tokens` is the estimate for this one call.
export function resolveRole(role, cfg, ledger, tokens, { skip = [], health, rotation } = {}) {
  const chain = cfg.chains[role];
  if (!chain) throw new Error(`unknown role: ${role}`);
  const candidates = [];
  for (const [i, key] of chain.entries()) {
    const def = cfg.routes[key];
    if (!def || skip.includes(key)) continue;
    if (isSeat(def)) {
      const picked = pickSeatMember(key, cfg, ledger, tokens, { skip, health, rotation, role });
      if (picked) candidates.push({ key: picked.key, def: picked.def, i, via: key, turn: picked.turn });
      continue;
    }
    if (!ledger.canSpend(key, tokens, role)) continue;
    candidates.push({ key, def, i });
  }
  if (candidates.length === 0) return { kind: "hold", reason: `${role}: budget exhausted on ${chain.join(" -> ")}` };
  const pick = candidates.find((c) => !health?.cooling(c.key)) ?? candidates[0];
  return {
    kind: "route",
    // `key` stays the MEMBER's key: budgets, cost caps, health, the skip list, the probe flag and
    // the ledger are all keyed by the route that actually ran. `via` names the office it came from.
    route: { key: pick.key, ...pick.def, ...(pick.via ? { via: pick.via, turn: pick.turn } : {}) },
    fellBack: pick.i > 0,
  };
}

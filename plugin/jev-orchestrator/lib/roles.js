// First route on the role's chain that the ledger can afford, that has not failed in this call (`skip`)
// and is not cooling down after a recent failure (`health`). If every affordable route is cooling, the
// cooldown is ignored and the chain is tried in order again. `tokens` is the estimate for this one call.
export function resolveRole(role, cfg, ledger, tokens, { skip = [], health } = {}) {
  const chain = cfg.chains[role];
  if (!chain) throw new Error(`unknown role: ${role}`);
  const affordable = [];
  for (const [i, key] of chain.entries()) {
    if (cfg.routes[key] && !skip.includes(key) && ledger.canSpend(key, tokens, role)) affordable.push({ key, i });
  }
  if (affordable.length === 0) return { kind: "hold", reason: `${role}: budget exhausted on ${chain.join(" -> ")}` };
  const ready = health ? affordable.filter((c) => !health.cooling(c.key)) : affordable;
  const pick = (ready.length ? ready : affordable)[0];
  return { kind: "route", route: { key: pick.key, ...cfg.routes[pick.key] }, fellBack: pick.i > 0 };
}

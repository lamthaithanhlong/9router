// Which tools a child agent is not offered, and what to do when this Harness refuses the filter.
//
// Measured in the desktop profile (0.5.0 bug): the child's tool filter may only name "global" tools.
// `subagent`, `subagent_fork` and `workflow` live on the child's own layer there, so naming them made
// tools.restrict() throw, the child never started, and every david_run died in 2-3 ms on every route:
//   tools.restrict() names unknown global tool "subagent"; known global tools: ask_user_question, bash, ...
// The headless profile used by dev/e2e registers them globally, which is why that check passed.

// Tools withheld from a child of this role (see config.childTools).
export function denyFor(cfg, role) {
  const deny = [...cfg.childTools.denyAll];
  if (role !== "worker") deny.push(...cfg.childTools.denyNonWorker);
  return deny;
}

// The Harness names every refused tool in its message:
//   tools.restrict() names unknown global tool "subagent"; known global tools: ...
//   tools.restrict() names unknown global tools "a", "b"; known global tools: ...
const REFUSED = /^tools\.restrict\(\) names unknown global tools? (.*?); known global tools: /;

export function refusedNames(error) {
  const m = REFUSED.exec(String(error?.message ?? error ?? ""));
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

// One instance per plugin instance (not per module), so nothing leaks between runs or tests.
export class ToolFilter {
  constructor(cfg) {
    this.cfg = cfg;
    this.refused = new Set();
  }

  deny(role) {
    return denyFor(this.cfg, role).filter((n) => !this.refused.has(n));
  }

  // Learn from a failed start. `sent` is the filter THAT attempt used. Returns the names to drop: only names
  // that attempt actually sent, so a refusal of anything else (or an unrelated error) returns [] and the caller
  // rethrows. It must be what was sent, not what the filter is now: when several children start together, a
  // sibling may already have learned the name, and this child still has to be told to retry (a bug in the first
  // version: the later siblings failed on Cursor and fell to the backup route).
  learn(error, sent) {
    const was = new Set(sent);
    const drop = refusedNames(error).filter((n) => was.has(n));
    for (const n of drop) this.refused.add(n);
    return drop;
  }
}

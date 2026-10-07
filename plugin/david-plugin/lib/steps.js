// One JSON line per transition, so `node watch.mjs` and the `david_watch` tool can show
// progress for free. Append-only, never throws: a full disk must not kill a run.
//
// `step(text, extra)` writes one line of JSON in this shape:
//   { ts, run, text, ...extra }
// `run` lives in `extra` so the pipeline can thread the runId through deps without the
// factory needing to know it; a caller that omits `run` simply writes no `run` key.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A caller may hand us a raw "~/.dsh/..." — the default below is written that way, and a
// config that copied it from the docs does the same. Expand it here as well as at the call
// site, so a forgotten expandHome() can never litter a literal "~" directory in the cwd.
function expandHome(p) {
  return typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function createSteps(cfg, { log = () => {} } = {}) {
  const configured = typeof cfg.stepsFile === "string" && cfg.stepsFile ? cfg.stepsFile : "~/.dsh/david-steps.jsonl";
  const file = expandHome(configured);
  let warned = false;
  // One line per broken feed, not one per step: a run that cannot write its feed must not
  // also flood the harness log with the same error hundreds of times.
  const note = (msg) => { if (!warned) { warned = true; log(msg); } };

  return {
    step(text, extra = {}) {
      const ts = new Date().toISOString();
      // Key order is part of the documented shape: ts, run, text, then any extras.
      const { run, ...rest } = extra;
      const entry = { ts, ...(run === undefined ? {} : { run }), text, ...rest };
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(entry)}\n`);
      } catch (err) {
        note(`steps.append failed: ${err.message || err}`);
      }
    },
  };
}

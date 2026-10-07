import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// One JSON line per jev_run, so "who ran" can be answered after the fact.
// Never throws: a log problem must not fail a run.
export function recordRun(file, entry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  }
}

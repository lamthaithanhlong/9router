// 0.9.0 renamed the data files `jev-*` to `david-*` (the run log, the steps feed and the spend ledger).
// The history in the old files belongs to the owner, so a file that exists under the old name and not yet under
// the new one is COPIED across: never moved, because a Harness that has not restarted yet may still be appending
// to the old one, and the original stays where it was.
import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const legacyName = (target) => join(dirname(target), basename(target).replace(/^david-/, "jev-"));

export function migrateLegacyFiles(targets, log = () => {}) {
  const copied = [];
  for (const target of targets) {
    if (typeof target !== "string" || !basename(target).startsWith("david-")) continue;
    const old = legacyName(target);
    try {
      if (!existsSync(target) && existsSync(old)) {
        copyFileSync(old, target);
        copied.push(target);
        log(`kept your history: copied ${old} to ${target} (the data files were renamed in 0.9.0)`);
      }
    } catch (err) {
      log(`could not copy ${old} to ${target}: ${err.message ?? err}`); // the run goes on with an empty file
    }
  }
  return copied;
}

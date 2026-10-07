// Import this FIRST in every test file. Tests build the plugin with its default paths
// (~/.dsh/david-runs.jsonl, ~/.dsh/david-ledger.json); without a sandbox HOME they wrote
// into the real ~/.dsh (41 junk lines in the real run log before this existed).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "david-home-"));
process.env.HOME = SANDBOX_HOME;

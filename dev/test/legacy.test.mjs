import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { legacyName, migrateLegacyFiles } from "../../plugin/david-plugin/lib/legacy.js";

const dir = () => mkdtempSync(join(tmpdir(), "david-"));

test("legacy: the old jev-* file is copied to its david-* name and the original is left alone", () => {
  const d = dir();
  writeFileSync(join(d, "jev-runs.jsonl"), "one\ntwo\n");
  const logs = [];
  const copied = migrateLegacyFiles([join(d, "david-runs.jsonl")], (m) => logs.push(m));
  assert.deepEqual(copied, [join(d, "david-runs.jsonl")]);
  assert.equal(readFileSync(join(d, "david-runs.jsonl"), "utf8"), "one\ntwo\n");
  assert.equal(readFileSync(join(d, "jev-runs.jsonl"), "utf8"), "one\ntwo\n", "a Harness that has not restarted may still be appending to it");
  assert.match(logs[0], /copied .*jev-runs\.jsonl to .*david-runs\.jsonl/);
});

test("legacy: a david-* file that exists is never overwritten, and a missing source is not an error", () => {
  const d = dir();
  writeFileSync(join(d, "jev-ledger.json"), "OLD");
  writeFileSync(join(d, "david-ledger.json"), "NEW");
  assert.deepEqual(migrateLegacyFiles([join(d, "david-ledger.json"), join(d, "david-steps.jsonl")]), []);
  assert.equal(readFileSync(join(d, "david-ledger.json"), "utf8"), "NEW");
  assert.ok(!existsSync(join(d, "david-steps.jsonl")));
});

test("legacy: only david-* names are touched (a custom file name is the owner's own)", () => {
  const d = dir();
  writeFileSync(join(d, "jev-custom.jsonl"), "x");
  assert.deepEqual(migrateLegacyFiles([join(d, "custom.jsonl"), join(d, "mine.jsonl"), null, undefined]), []);
  assert.ok(!existsSync(join(d, "custom.jsonl")));
  assert.equal(legacyName("/x/david-steps.jsonl"), "/x/jev-steps.jsonl");
});

test("legacy: a copy that fails is logged and does not throw (the run goes on with an empty file)", () => {
  const d = dir();
  mkdirSync(join(d, "jev-runs.jsonl")); // a directory where the old file should be: copyFileSync throws EISDIR
  const logs = [];
  assert.deepEqual(migrateLegacyFiles([join(d, "david-runs.jsonl")], (m) => logs.push(m)), []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /could not copy/);
  assert.deepEqual(migrateLegacyFiles([join(d, "no-such-dir", "david-runs.jsonl")]), [], "a folder that does not exist is skipped, not fatal");
});

test("legacy: merely importing telemetry writes nothing (a dev script that imports the plugin must not touch ~/.dsh)", async () => {
  const d = dir();
  writeFileSync(join(d, "jev-runs.jsonl"), '{"ts":"t"}\n');
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = d;
  try {
    await import(`../../plugin/david-plugin/lib/telemetry.js?fresh=${Date.now()}`);
  } finally {
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
  }
  assert.ok(!existsSync(join(d, "david-runs.jsonl")), "an import that copies files once created david-* in the real ~/.dsh from a verify script");
});

const run = (script, args, env) => execFileSync("node", [join(fileURLToPath(new URL("../../plugin/david-plugin/", import.meta.url)), script), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("legacy: watch.mjs, run first after the rename, brings the history across before it reads", () => {
  const home = dir();
  const dsh = join(home, ".dsh");
  mkdirSync(dsh, { recursive: true });
  writeFileSync(join(dsh, "jev-runs.jsonl"), '{"ts":"2026-10-07T10:00:00.000Z","status":"done","task":"old run"}\n');
  writeFileSync(join(dsh, "jev-steps.jsonl"), '{"ts":"2026-10-07T10:00:00.000Z","text":"old step"}\n');
  const out = run("watch.mjs", ["--once"], { HOME: home, DSH_HOME: dsh });
  assert.match(out, /old run/, "the old run is shown, not an empty history");
  assert.equal(readFileSync(join(dsh, "david-steps.jsonl"), "utf8"), '{"ts":"2026-10-07T10:00:00.000Z","text":"old step"}\n');
  assert.ok(existsSync(join(dsh, "jev-steps.jsonl")), "the original stays");
});

test("legacy: who.mjs does the same for the run log", () => {
  const home = dir();
  mkdirSync(join(home, ".dsh"), { recursive: true });
  writeFileSync(join(home, ".dsh", "jev-runs.jsonl"), '{"ts":"2026-10-07T10:00:00.000Z","end":"2026-10-07T10:01:00.000Z","status":"done","cwd":"/r","task":"old run","trace":[]}\n');
  const out = run("who.mjs", ["1"], { HOME: home, ROUTER9_DB: join(home, "none.sqlite") });
  assert.match(out, /old run/);
  assert.ok(existsSync(join(home, ".dsh", "david-runs.jsonl")));
});

test("e2e: the script keeps every file the plugin writes inside its temp dir (it once filled the real feed with fake runs)", () => {
  const sh = readFileSync(join(fileURLToPath(new URL("../e2e/", import.meta.url)), "run.sh"), "utf8");
  for (const key of ["runLog", "ledgerFile", "stepsFile"]) {
    assert.match(sh, new RegExp(`${key}: \\$D/`), `run.sh must point ${key} at $D, or the e2e scenarios write to ~/.dsh`);
  }
});

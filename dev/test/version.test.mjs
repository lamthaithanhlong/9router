import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTool, version } from "../../plugin/david-plugin/index.js";
import { Ledger } from "../../plugin/david-plugin/lib/budget.js";
import { resolveConfig } from "../../plugin/david-plugin/lib/config.js";
import { formatReport } from "../../plugin/david-plugin/lib/pipeline.js";
import { formatRun, readRuns } from "../../plugin/david-plugin/who.mjs";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "david-"));
const pkgJson = () => JSON.parse(readFileSync(join(PKG, "plugin/david-plugin/package.json"), "utf8"));
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Stub launchctl first on PATH: nothing here may reach the real launchd.
const STUB = tmp();
writeFileSync(join(STUB, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const run = (script, args, env = {}) => execFileSync("bash", [join(PKG, script), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${STUB}:${process.env.PATH}`, DAVID_SKIP_LAUNCHCTL: "1", ...env } });

test("package.json carries a SemVer version", () => {
  assert.match(pkgJson().version, SEMVER);
});

test("the module exports the same version as package.json", () => {
  assert.equal(version, pkgJson().version);
});

test("CHANGELOG's newest released entry is this version, dated", () => {
  const log = readFileSync(join(PKG, "CHANGELOG.md"), "utf8");
  const first = /^## \[(\d+\.\d+\.\d+[^\]]*)\] - (\d{4}-\d{2}-\d{2})$/m.exec(log);
  assert.ok(first, "no released entry in CHANGELOG.md");
  assert.equal(first[1], pkgJson().version, "CHANGELOG top entry and package.json disagree");
  assert.match(log, /^## \[Unreleased\]$/m);
});

test("report footer names the plugin version; no footer when no version is given", () => {
  const out = { status: "done", notes: [], plan: "", triggers: [] };
  assert.match(formatReport(out, undefined, "9.8.7"), /\n\nPlugin: david plugin 9\.8\.7$/);
  assert.ok(!/Plugin:/.test(formatReport(out)));
});

test("every run-log line carries the version, and who.mjs shows it", async () => {
  const log = join(tmp(), "runs.jsonl");
  const cfg = resolveConfig({ runLog: log, laya: { enabled: false } });
  const ctx = { subagents: { resolveMaxDepth: () => 1, start: async () => ({ result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }), dispose() {} }) } };
  const tool = buildTool(ctx, cfg, new Ledger(join(tmp(), "l.json"), cfg.budgets));
  await tool.execute({ task: "t", cwd: "/nonexistent/repo", plan: "no" }, { agent: {}, signal: new AbortController().signal }).catch(() => {});
  const [r] = readRuns(log, 1);
  assert.equal(r.version, version);
  assert.match(formatRun(r), new RegExp(`\\(plugin ${version.replace(/\./g, "\\.")}\\)`));
});

test("install.sh says which version it replaces", () => {
  const home = tmp();
  const dsh = join(home, ".dsh");
  mkdirSync(join(dsh, "profiles", "desktop"), { recursive: true });
  writeFileSync(join(dsh, "profiles", "desktop", "cordis.patch.yml"), "- id: x\n  name: y\n");
  const env = { HOME: home, DSH_HOME: dsh };
  assert.match(run("install.sh", ["--no-check"], env), new RegExp(`version: new install, ${version}`));
  assert.match(run("install.sh", ["--no-check"], env), new RegExp(`version: ${version} \\(same version reinstalled\\)`));
  const installed = join(dsh, "profiles", "desktop", "plugins", "david-plugin", "package.json");
  writeFileSync(installed, readFileSync(installed, "utf8").replace(version, "0.0.1"));
  assert.match(run("install.sh", ["--no-check"], env), new RegExp(`version: 0\\.0\\.1 -> ${version.replace(/\./g, "\\.")}`));
});

function copyPkg() {
  const dir = join(tmp(), "pkg");
  cpSync(PKG, dir, { recursive: true, filter: (p) => !/\/(dist|\.git)(\/|$)/.test(p) }); // the real .git is big and never packed
  return dir;
}
const build = (dir, outDir) => execFileSync("bash", [join(dir, "dev/build.sh"), "--skip-tests"], { encoding: "utf8", env: { ...process.env, OUT_DIR: outDir } });

test("build.sh produces a zip named with the version, containing that version", () => {
  const out = tmp();
  const dir = copyPkg();
  // a previous build left a zip in dist/: it must not be packed into the next one
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "stale-previous-build.zip"), "x");
  const text = build(dir, out);
  const zip = join(out, `david-plugin-${version}.zip`);
  assert.ok(existsSync(zip));
  assert.match(text, /sha256 [0-9a-f]{64}/);
  const inner = JSON.parse(execFileSync("unzip", ["-p", zip, "david-plugin/plugin/david-plugin/package.json"], { encoding: "utf8" }));
  assert.equal(inner.version, version);
  const listing = execFileSync("unzip", ["-l", zip], { encoding: "utf8" });
  assert.ok(!/stale-previous-build/.test(listing), "dist/ leaked into the zip");
  assert.ok(!/\.DS_Store/.test(listing));
});

test("build.sh packs the plugin AND the david-force skill, and never the git history", () => {
  const out = tmp();
  const dir = copyPkg();
  // a checkout has a .git folder, and a Python run leaves __pycache__: neither may ship
  mkdirSync(join(dir, ".git", "objects"), { recursive: true });
  writeFileSync(join(dir, ".git", "objects", "pack-huge"), "x".repeat(1000));
  mkdirSync(join(dir, "skill", "david-force", "scripts", "__pycache__"), { recursive: true });
  writeFileSync(join(dir, "skill", "david-force", "scripts", "__pycache__", "common.cpython-313.pyc"), "x");
  build(dir, out);
  const zip = join(out, `david-plugin-${version}.zip`);
  const listing = execFileSync("unzip", ["-l", zip], { encoding: "utf8" });
  assert.ok(!/\/\.git\//.test(listing), ".git leaked into the zip (it once made every zip twice the size of the last)");
  assert.ok(!/__pycache__|\.pyc/.test(listing));
  for (const want of ["install.sh", "uninstall.sh", "plugin/david-plugin/package.json", "plugin/david-plugin/lib/force.js",
    "skill/david-force/SKILL.md", "skill/david-force/scripts/force.py", "skill/david-force/scripts/force_guard.py",
    "skill/david-force/scripts/force_hook.py", "skill/david-force/scripts/david", "skill/david-force/tests/commands.json"]) {
    assert.ok(listing.includes(`david-plugin/${want}`), `the zip is missing ${want}`);
  }
  assert.ok(statSync(zip).size < 3_000_000, `the zip is ${statSync(zip).size} bytes: something big got packed`);
});

test("build.sh refuses a package without the skill (a zip that cannot make david mandatory)", () => {
  const dir = copyPkg();
  rmSync(join(dir, "skill", "david-force", "SKILL.md"));
  assert.throws(() => build(dir, tmp()), (e) => /missing skill\/david-force\/SKILL\.md/.test(e.stderr));
});

test("build.sh refuses a version that is not SemVer, or has no changelog entry", () => {
  const dir = copyPkg();
  const pj = join(dir, "plugin/david-plugin/package.json");
  const original = readFileSync(pj, "utf8");
  writeFileSync(pj, original.replace(version, "0.9"));
  assert.throws(() => build(dir, tmp()), (e) => /not SemVer/.test(e.stderr));
  writeFileSync(pj, original.replace(version, "9.9.9"));
  assert.throws(() => build(dir, tmp()), (e) => /no '## \[9\.9\.9\]/.test(e.stderr));
});

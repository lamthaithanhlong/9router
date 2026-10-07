import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));
// Every script run in a test gets a stub `launchctl` first on PATH that only records its arguments.
// A broken JEV_SKIP_LAUNCHCTL switch then hits the stub, never the real launchd (a mutated install.sh
// once registered a bogus com.jev.laya-keepalive job on the real machine).
const STUB_DIR = tmp();
const STUB_LOG = join(STUB_DIR, "calls.log");
writeFileSync(join(STUB_DIR, "launchctl"), `#!/bin/sh\necho "$@" >> "${STUB_LOG}"\n`, { mode: 0o755 });
const stubCalls = () => (existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").trim().split("\n").filter(Boolean) : []);
const resetStub = () => writeFileSync(STUB_LOG, "");
const sh = (script, args, env, { skipLaunchctl = true } = {}) =>
  execFileSync("bash", [join(PKG, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}`, ...(skipLaunchctl ? { JEV_SKIP_LAUNCHCTL: "1" } : {}), ...env },
  });

// A fake machine: its own HOME with a LaunchAgents dir, and a Harness home with a desktop profile.
function machine() {
  const home = tmp();
  const dsh = join(home, ".dsh");
  mkdirSync(join(dsh, "profiles", "desktop"), { recursive: true });
  writeFileSync(join(dsh, "profiles", "desktop", "cordis.patch.yml"), "- id: x\n  name: y\n");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  return { home, dsh, plist: join(home, "Library", "LaunchAgents", "com.jev.laya-keepalive.plist") };
}

test("sandbox: tests never see the real HOME", () => {
  assert.match(homedir(), /jev-home-/);
});

test("every test file imports the sandbox first (a new file that forgets would write into the real ~/.dsh)", () => {
  const dir = join(PKG, "dev", "test");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".test.mjs"))) {
    // The import must come first; the binding form may differ — a file that also needs
    // SANDBOX_HOME writes `import { SANDBOX_HOME } from "./_sandbox.mjs";`, which is the same
    // side effect and must not be rejected for its shape.
    const first = readFileSync(join(dir, f), "utf8").split("\n", 1)[0].trim();
    assert.ok(
      /^import\s.*["']\.\/_sandbox\.mjs["'];?$/.test(first),
      `${f} must start with the sandbox import (first line: ${first})`,
    );
  }
});

test("uninstall leaves a LaunchAgent that belongs to ANOTHER Harness home alone (this once deleted the real job)", () => {
  const m = machine();
  writeFileSync(m.plist, "<plist>/Users/someone/.dsh/jev/laya-keepalive.sh</plist>");
  const otherDsh = join(tmp(), ".dsh");
  mkdirSync(join(otherDsh, "profiles", "desktop"), { recursive: true });
  sh("uninstall.sh", [], { HOME: m.home, DSH_HOME: otherDsh });
  assert.ok(existsSync(m.plist), "the real job's plist was removed by an unrelated uninstall");
});

test("uninstall removes the LaunchAgent that runs this home's script, and nothing else of the user's", () => {
  const m = machine();
  mkdirSync(join(m.dsh, "jev"), { recursive: true });
  const script = join(m.dsh, "jev", "laya-keepalive.sh");
  writeFileSync(script, "#!/bin/sh\n");
  writeFileSync(m.plist, `<plist>${script}</plist>`);
  sh("uninstall.sh", [], { HOME: m.home, DSH_HOME: m.dsh });
  assert.ok(!existsSync(m.plist) && !existsSync(script));
  assert.ok(existsSync(join(m.dsh, "profiles", "desktop", "cordis.patch.yml")));
});

test("install --keepalive writes a plist that points at this home's script and abandons the process group", () => {
  const m = machine();
  sh("install.sh", ["--keepalive", "--no-check"], { HOME: m.home, DSH_HOME: m.dsh });
  const plist = readFileSync(m.plist, "utf8");
  assert.ok(plist.includes(join(m.dsh, "jev", "laya-keepalive.sh")));
  assert.match(plist, /AbandonProcessGroup<\/key><true\/>/);
  assert.ok(existsSync(join(m.dsh, "profiles", "desktop", "plugins", "david-plugin", "index.js")));
});

test("install then uninstall returns the patch file byte for byte", () => {
  const m = machine();
  const patch = join(m.dsh, "profiles", "desktop", "cordis.patch.yml");
  const before = readFileSync(patch);
  sh("install.sh", ["--no-check"], { HOME: m.home, DSH_HOME: m.dsh });
  assert.notDeepEqual(readFileSync(patch), before);
  sh("uninstall.sh", [], { HOME: m.home, DSH_HOME: m.dsh });
  assert.deepEqual(readFileSync(patch), before);
});

test("JEV_SKIP_LAUNCHCTL keeps install and uninstall away from launchd entirely", () => {
  const m = machine();
  resetStub();
  sh("install.sh", ["--keepalive", "--no-check"], { HOME: m.home, DSH_HOME: m.dsh });
  sh("uninstall.sh", [], { HOME: m.home, DSH_HOME: m.dsh });
  assert.deepEqual(stubCalls(), [], `launchctl was called: ${JSON.stringify(stubCalls())}`);
});

test("without the switch, install.sh does register the job (positive control for the stub)", () => {
  const m = machine();
  resetStub();
  sh("install.sh", ["--keepalive", "--no-check"], { HOME: m.home, DSH_HOME: m.dsh }, { skipLaunchctl: false });
  const calls = stubCalls();
  assert.ok(calls.some((c) => c.startsWith("bootstrap")), `expected a bootstrap call, got ${JSON.stringify(calls)}`);
  resetStub();
  sh("uninstall.sh", [], { HOME: m.home, DSH_HOME: m.dsh }, { skipLaunchctl: false });
  assert.ok(stubCalls().some((c) => c.startsWith("bootout")));
});

// The plugin was called "jev-orchestrator" up to 0.7.x. An existing install must become "david-plugin" without
// losing the block the owner edited by hand (routes, budgets, chains live there).
const OLD_BLOCK = [
  "# jev-orchestrator:begin",
  "- insert:",
  "    - id: jev-orchestrator",
  "      name: ./plugins/jev-orchestrator/index.js",
  "      config:",
  "        budgets: { codex: { daily: 123 } }   # hand-edited",
  "# jev-orchestrator:end",
  "",
].join("\n");

function oldInstall(m) {
  const profile = join(m.dsh, "profiles", "desktop");
  const patch = join(profile, "cordis.patch.yml");
  const outside = "- id: other\n  name: keep-me\n";
  writeFileSync(patch, outside + OLD_BLOCK + "# backend-review-mission:begin\n- id: mission\n# backend-review-mission:end\n");
  mkdirSync(join(profile, "plugins", "jev-orchestrator"), { recursive: true });
  writeFileSync(join(profile, "plugins", "jev-orchestrator", "package.json"), '{ "name": "jev-orchestrator", "version": "0.7.7" }');
  writeFileSync(join(profile, "plugins", "jev-orchestrator", "index.js"), "// old\n");
  return { profile, patch };
}

test("install over a jev-orchestrator install renames it in place and keeps the hand-edited block", () => {
  const m = machine();
  const { profile, patch } = oldInstall(m);
  const before = readFileSync(patch, "utf8");
  const out = sh("install.sh", ["--no-check"], { HOME: m.home, DSH_HOME: m.dsh });
  assert.ok(!/new install/.test(out), "the old copy counts as the install being upgraded");
  assert.match(out, /version: 0\.7\.7/, "the old version is read from the old folder");
  assert.ok(!existsSync(join(profile, "plugins", "jev-orchestrator")), "the old copy is removed");
  assert.ok(existsSync(join(profile, "plugins", "david-plugin", "index.js")));

  const after = readFileSync(patch, "utf8");
  assert.ok(!/jev-orchestrator/.test(after), "no trace of the old name is left in the patch");
  assert.equal((after.match(/^# david-plugin:begin$/gm) ?? []).length, 1, "exactly one block, not the template appended on top");
  assert.match(after, /^    - id: david-plugin$/m);
  assert.match(after, /^      name: \.\/plugins\/david-plugin\/index\.js$/m);
  assert.ok(after.includes("        budgets: { codex: { daily: 123 } }   # hand-edited\n"), "the owner's own config survives");
  // everything outside the block is byte for byte what it was
  assert.ok(after.startsWith("- id: other\n  name: keep-me\n"));
  assert.ok(after.endsWith("# backend-review-mission:begin\n- id: mission\n# backend-review-mission:end\n"));
  assert.ok(readdirSync(profile).some((f) => f.startsWith("cordis.patch.yml.bak-rename-")), "a backup of the old patch is kept");
  assert.equal(readFileSync(join(profile, readdirSync(profile).find((f) => f.startsWith("cordis.patch.yml.bak-rename-"))), "utf8"), before);

  // running it again changes nothing
  const again = sh("install.sh", ["--no-check"], { HOME: m.home, DSH_HOME: m.dsh });
  assert.match(again, /patch entry already present/);
  assert.equal(readFileSync(patch, "utf8"), after);
});

test("uninstall removes an install that still has the old name", () => {
  const m = machine();
  const { profile, patch } = oldInstall(m);
  sh("uninstall.sh", [], { HOME: m.home, DSH_HOME: m.dsh });
  assert.ok(!existsSync(join(profile, "plugins", "jev-orchestrator")));
  assert.equal(readFileSync(patch, "utf8"), "- id: other\n  name: keep-me\n# backend-review-mission:begin\n- id: mission\n# backend-review-mission:end\n");
});

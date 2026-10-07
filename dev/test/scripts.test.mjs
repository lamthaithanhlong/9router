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
    assert.ok(readFileSync(join(dir, f), "utf8").startsWith('import "./_sandbox.mjs";'), `${f} must start with the sandbox import`);
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
  assert.ok(existsSync(join(m.dsh, "profiles", "desktop", "plugins", "jev-orchestrator", "index.js")));
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

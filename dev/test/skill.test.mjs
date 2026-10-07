import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// The david-force skill is Python (it runs as Codex hooks and as a CLI); its tests live beside it and run here so one
// `node --test dev/test/*.test.mjs` covers the whole package.
test("skill david-force: the Python unit tests pass", () => {
  let out = "";
  try {
    out = execFileSync("python3", ["-m", "unittest", "discover", "-s", "skill/david-force/tests"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`python tests failed:\n${e.stderr || e.stdout}`);
  }
  // unittest prints its summary on stderr, which execFileSync only returns on failure: reaching here means exit code 0
  assert.equal(out, "");
});

test("skill david-force: SKILL.md has the front matter a harness needs and documents on/off/status", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(`${ROOT}skill/david-force/SKILL.md`, "utf8");
  const front = /^---\nname: david-force\ndescription: (.+)\n---\n/.exec(md);
  assert.ok(front, "front matter with name and description");
  for (const cmd of ["/david-force on", "/david-force off", "/david-force status"]) assert.ok(md.includes(cmd), cmd);
  assert.match(front[1], /on/i);
});

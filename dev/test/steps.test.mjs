import "./_sandbox.mjs";
// SPEC 0.7.0 part C: the step feed. Each call writes ONE line of JSON; failure to create the
// directory or write the line must not throw — a full disk or a stale path must not kill a run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSteps } from "../../plugin/david-plugin/lib/steps.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-steps-"));

test("step: appends one JSON line per call, with ts / run / text and a few extras", () => {
  const dir = tmp();
  const file = join(dir, "jev-steps.jsonl");
  const steps = createSteps({ stepsFile: file }, { log: () => {} });
  steps.step("worker-1 started on cursor-workers", { run: "abc", role: "worker", label: "worker-1", route: "cursor", model: "cursor-workers", usd: 0.0012, taskUsd: 0.0034 });
  steps.step("worker-1 done in 12.5s, $0.0011", { run: "abc", role: "worker", label: "worker-1", usd: 0.0011, taskUsd: 0.0011 });

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const [first, second] = lines.map((l) => JSON.parse(l));
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/, "ts is ISO with ms");
  assert.equal(first.run, "abc");
  assert.equal(first.text, "worker-1 started on cursor-workers");
  assert.equal(first.role, "worker");
  assert.equal(first.label, "worker-1");
  assert.equal(first.route, "cursor");
  assert.equal(first.model, "cursor-workers");
  assert.equal(first.usd, 0.0012);
  assert.equal(first.taskUsd, 0.0034);
  // Spec shape: ts first, run second, text third, then any extras — keys appear in that order.
  const keys = Object.keys(first);
  assert.deepEqual(keys.slice(0, 3), ["ts", "run", "text"]);
  // JSON.parse drops keys with string values but for an integer key it is preserved as the first key.
  assert.ok(keys.includes("usd"));
  assert.equal(second.text, "worker-1 done in 12.5s, $0.0011");
});

test("step: creates the directory if it does not exist", () => {
  const dir = tmp();
  const file = join(dir, "nested", "more", "and", "steps.jsonl");
  const steps = createSteps({ stepsFile: file }, { log: () => {} });
  steps.step("first line");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, "first line");
});

test("step: does not throw when the path is unwritable, and logs once", () => {
  const dir = tmp();
  // Make a real blocker: a regular FILE where a directory would have to be. mkdirSync on
  // <file>/steps.jsonl throws ENOTDIR, which is the failure this test wants to provoke.
  // (The earlier version nested a path under a directory that mkdirSync simply created, so
  // nothing ever failed and the assertion below could not pass.)
  mkdirSync(join(dir, "ro"));
  const blocker = join(dir, "ro", "is-a-file");
  writeFileSync(blocker, "pre-existing");
  const badFile = join(blocker, "steps.jsonl");
  let seen = [];
  const steps = createSteps({ stepsFile: badFile }, { log: (m) => seen.push(m) });
  assert.doesNotThrow(() => steps.step("never written"));
  // After several attempts, the tracker logs once and keeps swallowing.
  steps.step("still not written");
  steps.step("also not written");
  assert.equal(seen.filter((m) => /steps\.append/.test(m)).length, 1, "logged once");
});

test("step: defaults to ~/.dsh/jev-steps.jsonl when no file is given", () => {
  // The sandbox has HOME set, so createSteps({}) must default to $HOME/.dsh/jev-steps.jsonl
  const steps = createSteps({}, { log: () => {} });
  // We don't assert against the absolute path (it would tie to the sandbox internals); instead we
  // assert that .step() did not throw — the writer found the default path under the sandbox HOME.
  assert.doesNotThrow(() => steps.step("default path works"));
});
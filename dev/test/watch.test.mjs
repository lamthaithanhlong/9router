import "./_sandbox.mjs";
// watch.mjs must not replay the oldest rows of usageHistory as if they were live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("--once prints the last 20 calls, newest data, with a date for old rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-watch-"));
  const file = join(dir, "data.sqlite");
  const db = new DatabaseSync(file);
  db.exec("create table usageHistory (id integer primary key autoincrement, provider text, model text, promptTokens int, completionTokens int, cost real, timestamp text)");
  const ins = db.prepare("insert into usageHistory (provider, model, promptTokens, completionTokens, cost, timestamp) values (?,?,?,?,?,?)");
  for (let i = 1; i <= 60; i++) ins.run("p", "m" + i, i, 1, 0.001, `2026-10-05T10:00:${String(i % 60).padStart(2, "0")}.000Z`);
  db.close();
  const out = execFileSync("node", ["plugin/david-plugin/watch.mjs", "--once"], {
    encoding: "utf8",
    env: { ...process.env, JEV_9ROUTER_DB: file, HOME: dir },
  });
  const calls = out.split("\n").filter((l) => /  call   /.test(l));
  assert.equal(calls.length, 20);
  assert.ok(calls[0].includes("m41") && calls.at(-1).includes("m60"), "must be the newest 20, in order");
  assert.ok(calls[0].startsWith("10-05 "), "old rows carry their date");
});

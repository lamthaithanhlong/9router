import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const plist = readFileSync(new URL("../../scripts/com.jev.laya-keepalive.plist", import.meta.url), "utf8");
const script = readFileSync(new URL("../../scripts/laya-keepalive.sh", import.meta.url), "utf8");

test("keepalive plist keeps Laya alive after the job exits (measured failure: without this launchd killed Laya)", () => {
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
});

test("keepalive plist runs at load and every minute", () => {
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(plist, /REPLACE_SCRIPT/); // install.sh substitutes the real path
});

test("keepalive script only starts Laya when status says it is down", () => {
  assert.match(script, /"\$CTL" status >\/dev\/null 2>&1 \|\| "\$CTL" start/);
  assert.match(script, /\[ -x "\$CTL" \] \|\| exit 0/);
});

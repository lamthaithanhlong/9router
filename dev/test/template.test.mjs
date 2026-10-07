import "./_sandbox.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// The skeleton in PLUGIN-TEMPLATE.md must keep working: extract it, load it, drive it.
const md = readFileSync(new URL("../../PLUGIN-TEMPLATE.md", import.meta.url), "utf8");
const block = /<!-- skeleton:index\.js -->\s*```js\n([\s\S]*?)```/.exec(md)?.[1];

test("the template contains the skeleton block", () => {
  assert.ok(block && block.includes("export function apply"));
});

test("skeleton loads, registers one tool, and the tool runs", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-")), "index.mjs");
  writeFileSync(file, block);
  const mod = await import(pathToFileURL(file).href);
  assert.equal(mod.name, "my-plugin");
  assert.deepEqual(mod.inject, ["tools"]);

  const registered = [];
  mod.apply({ tools: { register: (t) => registered.push(t) } }, { greeting: "hi" });
  assert.equal(registered.length, 1);
  const [tool] = registered;
  assert.equal(tool.name, "my_tool");
  assert.deepEqual(tool.parameters.required, ["who"]);
  assert.equal(await tool.execute({ who: "Long" }, { signal: new AbortController().signal }), "hi, Long");
  assert.deepEqual(tool.output.render({}, "x"), [{ type: "text", text: "x" }]);
});

test("the template's patch snippet and the shipped patch use the same insert form", () => {
  const shipped = readFileSync(new URL("../../patch/david-plugin.patch.yml", import.meta.url), "utf8");
  assert.match(shipped, /- insert:\s*\n\s+- id: david-plugin\s*\n\s+name: \.\/plugins\/david-plugin\/index\.js/);
  assert.match(md, /- insert:\s*\n\s+- id: my-plugin\s*\n\s+name: \.\/plugins\/my-plugin\/index\.js/);
});

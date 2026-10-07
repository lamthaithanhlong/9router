// Checks the hand-written tool definition against the Harness's own
// defineTool(), so a schema mistake shows up here and not at model-call time.
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" dev/verify-against-harness.mjs
//
// Reads the packages inside the app bundle; changes nothing.
import assert from "node:assert/strict";
import { buildTool } from "../plugin/david-plugin/index.js";
import { Ledger } from "../plugin/david-plugin/lib/budget.js";
import { resolveConfig } from "../plugin/david-plugin/lib/config.js";

const PKGS =
  process.env.DSH_PKGS ?? "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai";
const { defineTool } = await import(`${PKGS}/dsh-tools/lib/index.js`);

const cfg = resolveConfig();
const mine = buildTool({ subagents: {} }, cfg, new Ledger("/nonexistent/ledger.json", cfg.budgets));

// Same definition in the Harness's authoring form: property map, `required: true` per property.
const spec = Object.fromEntries(
  Object.entries(mine.parameters.properties).map(([k, v]) => [k, { ...v, ...(mine.parameters.required.includes(k) ? { required: true } : {}) }]),
);
const real = defineTool({
  name: mine.name,
  description: mine.description,
  parameters: spec,
  output: { schema: { type: "string" }, render: mine.output.render },
  timeoutMs: mine.timeoutMs,
  async execute() {
    return "";
  },
});

assert.deepEqual(mine.parameters, real.parameters, "parameters differ from what defineTool compiles");
assert.deepEqual(mine.output.schema, real.output.schema, "output schema differs from what defineTool compiles");
assert.equal(mine.timeoutMs, real.timeoutMs);
console.log("ok: parameters, output schema and timeout match the Harness's defineTool()");

// Argument validation goes through the real tool: bad args are refused before execute() runs.
await assert.rejects(real.execute({ task: "t" }, {}), /invalid arguments/, "missing cwd must be refused");
await assert.rejects(real.execute({ task: "t", cwd: "/x", tasks: "not-an-array" }, {}), /invalid arguments/);
console.log("ok: real defineTool refuses missing/ill-typed arguments for this schema");

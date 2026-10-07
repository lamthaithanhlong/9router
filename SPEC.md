# SPEC — jev-orchestrator 0.6.1: HTTP API routes for text-only roles

> BASE NOTE (added by the requester): this repo is the delivered 0.6.0 artifact and already
> contains `lib/toolfilter.js` (the 0.5.2 tool-filter race fix) and `lib/queue.js`.
> Never delete or weaken them; `node --test dev/test/*.test.mjs` must stay green (133 tests pass
> before you start). `dev/test/acceptance.api.test.mjs` is the requester's independent gate:
> it must pass too, and you must not edit it.

## Goal
Let the orchestrator run the **text-only roles** (`planner`, `researcher`, `reviewer`,
`final_reviewer`) on an external OpenAI-compatible HTTP API instead of the Harness subagent
provider. The `worker` role stays exactly as it is (Cursor subagent — it needs file tools).

## Hard rules
- Only touch files inside this repo. Never touch `~/.dsh`, never install, never restart anything.
- **Never log, print, or include an API key or an `Authorization` header** in any message, error,
  trace, or log line. Errors may name the env var, never its value.
- Never read `~/.dsh/.credentials.yaml`.
- Keep every existing test green. Node ESM only, no new dependencies.

## 1. New file `plugin/jev-orchestrator/lib/api.js`
Export `createApiSpawn(cfg, { fetchImpl = globalThis.fetch, log = () => {} } = {})` returning
`async function spawnApi(route, prompt, label, role)` that resolves to `{ text, tokensIn, tokensOut }`.

`route.api = { baseUrl, path = "/chat/completions", keyEnv, model, headers = {}, timeoutMs }`

- POST `${baseUrl}${path}` with JSON body
  `{ model: route.api.model ?? route.model, messages: [{ role: "user", content: prompt }], stream: false }`.
- Request headers: `content-type: application/json`, then `...route.api.headers`, then
  `authorization: "Bearer " + key`. Precedence must never leak the key into a log.
- `key = process.env[route.api.keyEnv]`. If undefined/empty → throw
  `api route <route.key> needs env <keyEnv>` (env var *name* only). The pipeline then falls back to
  the next route on the chain — that fallback must work.
- Timeout: `AbortSignal.timeout(route.api.timeoutMs ?? cfg.limits.apiTimeoutMs ?? 300_000)`; on abort
  throw an Error that says it timed out (do not dump the body).
- `!res.ok` → throw `api route <route.key>: HTTP <status> <first 300 chars of body>`; body only,
  never headers.
- `text`: `response.choices[0].message.content`; accept a plain string, or an array of
  `{ type: "text", text }` parts (join their text). Missing/empty → throw.
- `usage`: from `response.usage`; accept `{ prompt_tokens, completion_tokens }` **or**
  `{ input_tokens, output_tokens }`. If absent → `tokensIn = tokensOut = 0` (do **not** throw; the
  pipeline then keeps its estimate).
- No retries inside `api.js` — the pipeline already walks the chain.

## 2. `plugin/jev-orchestrator/lib/config.js`
- `routes`: add two entries
  - `api_deepseek`: `{ provider: "api", model: "deepseek-v4.1-flash", cost: "money", group: "api",
    api: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-chat" } }`
  - `api_openrouter`: `{ provider: "api", model: "openrouter-auto", cost: "money", group: "api",
    api: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", model: "openrouter/auto" } }`
  Base URL and model stay configurable (a 9Router base URL + `NINEROUTER_API_KEY` must be addable by
  config alone, with no code change).
- Add `limits.apiTimeoutMs: 300_000`.
- Add `api: { enabled: false }`. In `resolveConfig`:
  - `enabled === false` → **remove** every route whose `provider === "api"` from `routes`, and remove
    those keys from every chain (default behaviour must be byte-for-byte what it is today).
  - `enabled === true` → the api routes are inserted into the text-only chains
    (`planner`, `researcher`, `reviewer`, `final_reviewer`) **immediately before `"backup"`**,
    keeping their listing order. The `worker` chain is untouched in both cases.
- `budgets`: add a placeholder daily token cap for each api route (`unit: "tokens"`) so a runaway
  loop cannot spend without limit; comment that the number is a placeholder.
- Keep the invariant: a role names route keys, never models.

## 3. `plugin/jev-orchestrator/index.js`
- Import `createApiSpawn`. When `route.provider === "api"`, call `spawnApi` instead of
  `ctx.subagents.start(...)`. All subagent behaviour (labels, cancellation, `toolFilter`,
  refusal-retry, depth) stays exactly as today for subagent routes.
- Keep `spawnChild`'s existing signature and seam; do not move unrelated code.

## 4. `plugin/jev-orchestrator/lib/pipeline.js`
- `deps.spawn` may resolve to a string (as today) **or** `{ text, tokensIn, tokensOut }`.
- When the numbers are present, charge the ledger with `tokensIn + tokensOut`; otherwise keep
  today's `estimateTokens` path.
- Record `tokensIn`/`tokensOut` on the trace entry for that role when known.

## 5. New tests — `dev/test/api.test.mjs`
Use a fake fetch. Cover at least:
- happy path: text and usage mapped, and the ledger is charged the **real** numbers;
- `content` given as an array of parts;
- missing env var → throws naming the env var; set a fake key value in the env and assert that value
  does **not** appear in the thrown message;
- HTTP 500 → throws with the status, and the message contains no key value and no `Bearer `;
- timeout → throws;
- `api.enabled === false` → `resolveConfig` exposes no api route and no chain mentions one;
  `api.enabled === true` → api routes sit directly before `"backup"` in the four text-only chains,
  and the `worker` chain is unchanged.

## 6. Version
- `plugin/jev-orchestrator/package.json` → `"version": "0.6.1"`.
- `CHANGELOG.md` → add `## [0.6.1] - 2026-10-07` as the newest entry UNDER the existing
  `## [Unreleased]` line (build.sh requires exactly that format; the date is UTC).
- 0.6.0 is already taken by the Cursor file queue in this same repo: do NOT renumber or remove it.

## Acceptance — all must hold
- `node --test dev/test/*.test.mjs` → 0 failures.
- `OUT_DIR=/tmp/jev-061-dist ./dev/build.sh` → prints `built …` and `sha256 …`.
- `git status --porcelain` lists only intended files (no `dist/`, no stray files).

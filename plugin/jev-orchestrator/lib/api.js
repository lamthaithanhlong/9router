// External OpenAI-compatible HTTP API routes for the text-only roles.
// One call is one POST; there are no retries here because the pipeline
// already walks the chain. Secrets: the key travels in the request headers
// only. It is never logged, and it is scrubbed out of every error below
// (errors may name the env var, never its value).
export function createApiSpawn(cfg, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const scrub = (msg, key) => {
    let out = String(msg ?? "");
    if (key) out = out.split(key).join("[redacted]");
    out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer [redacted]");
    return out;
  };
  return async function spawnApi(route, prompt, label, role) {
    const name = route.key;
    const api = route.api ?? {};
    const url = `${api.baseUrl}${api.path ?? "/chat/completions"}`;
    const envName = api.keyEnv;
    const key = envName ? process.env[envName] : undefined;
    if (!key) throw new Error(`api route ${name} needs env ${envName}`);
    const timeoutMs = api.timeoutMs ?? cfg?.limits?.apiTimeoutMs ?? 300_000;
    const headers = { "content-type": "application/json", ...(api.headers ?? {}) };
    for (const h of Object.keys(headers)) {
      if (h.toLowerCase() === "authorization") delete headers[h];
    }
    headers.authorization = `Bearer ${key}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: api.model ?? route.model, messages: [{ role: "user", content: prompt }], stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new Error(`api route ${name} timed out after ${timeoutMs}ms`);
      }
      throw new Error(scrub(`api route ${name}: ${err?.message ?? err}`, key));
    }
    if (!res.ok) {
      let body = "";
      try {
        body = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json());
      } catch {
        body = "";
      }
      throw new Error(scrub(`api route ${name}: HTTP ${res.status} ${String(body).slice(0, 300)}`, key));
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(scrub(`api route ${name}: invalid JSON response`, key));
    }
    const content = data?.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("")
          : "";
    if (text.trim() === "") throw new Error(`api route ${name} returned no content`);
    const usage = data?.usage ?? {};
    const num = (v) => (Number.isFinite(v) ? v : 0);
    return { text, tokensIn: num(usage.prompt_tokens ?? usage.input_tokens), tokensOut: num(usage.completion_tokens ?? usage.output_tokens) };
  };
}

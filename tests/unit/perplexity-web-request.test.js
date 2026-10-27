/**
 * Offline request-shape test for perplexity-web (pplx-auto). No network:
 * global.fetch is stubbed and the cookie is a dummy value.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PerplexityWebExecutor } from "../../open-sse/executors/perplexity-web.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

async function captureRequest(model = "pplx-auto", extraBody = {}) {
  let captured;
  global.fetch = vi.fn(async (url, opts) => {
    captured = { url, opts };
    return new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const exec = new PerplexityWebExecutor();
  await exec.execute({
    model,
    body: { messages: [{ role: "user", content: "hello" }], ...extraBody },
    stream: false,
    credentials: { apiKey: "TEST" },
  });
  return captured;
}

describe("perplexity-web is listed as an LLM", () => {
  it("registry kinds include llm under the same rule getProvidersByKind / providers page use", () => {
    const entry = REGISTRY.find((r) => r.id === "perplexity-web");
    // src/shared/constants/providers.js: `p.serviceKinds ?? ["llm"]` — [] is not nullish, so it was hidden.
    const kinds = entry.serviceKinds ?? ["llm"];
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("llm");
  });

  it("every registry model id has an executor mapping (pplx-auto first)", () => {
    const entry = REGISTRY.find((r) => r.id === "perplexity-web");
    expect(entry.models[0].id).toBe("pplx-auto");
    expect(entry.models.map((m) => m.id)).toEqual([
      "pplx-auto", "pplx-sonar", "pplx-gpt", "pplx-gemini", "pplx-sonnet", "pplx-opus", "pplx-nemotron",
    ]);
  });
});

describe("perplexity-web pplx-auto request (offline)", () => {
  it("posts to the perplexity_ask SSE endpoint", async () => {
    const { url, opts } = await captureRequest();
    expect(url).toBe("https://www.perplexity.ai/rest/sse/perplexity_ask");
    expect(opts.method).toBe("POST");
  });

  it("sends the session cookie under __Secure-next-auth.session-token and the API version header", async () => {
    const { opts } = await captureRequest();
    expect(opts.headers.Cookie).toBe("__Secure-next-auth.session-token=TEST");
    expect(opts.headers["X-App-ApiVersion"]).toBe("2.18");
    expect(opts.headers.Accept).toBe("text/event-stream");
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it("maps pplx-auto to mode concise / preference pplx_pro with version 2.18", async () => {
    const { opts } = await captureRequest();
    const body = JSON.parse(opts.body);
    expect(body.params.mode).toBe("concise");
    expect(body.params.model_preference).toBe("pplx_pro");
    expect(body.params.version).toBe("2.18");
    expect(body.query_str).toBe(body.params.query_str);
  });

  it("maps the other registry models to copilot preferences", async () => {
    const expected = {
      "pplx-sonar": "experimental",
      "pplx-gpt": "gpt54",
      "pplx-gemini": "gemini31pro_high",
      "pplx-sonnet": "claude46sonnet",
      "pplx-opus": "claude46opus",
      "pplx-nemotron": "nv_nemotron_3_super",
    };
    for (const [model, pref] of Object.entries(expected)) {
      const { opts } = await captureRequest(model);
      const body = JSON.parse(opts.body);
      expect(body.params.mode).toBe("copilot");
      expect(body.params.model_preference).toBe(pref);
    }
  });
});

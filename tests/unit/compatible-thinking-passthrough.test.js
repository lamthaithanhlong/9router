// A compatible node's model is unknown to the capability table. The client's own
// thinking switch must reach the endpoint: a self-hosted gemma on Ollama answers
// with empty content when reasoning_effort:"none" is stripped.
import { describe, it, expect } from "vitest";
const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

describe("applyThinking on a compatible node", () => {
  it("keeps reasoning_effort for an unknown model", () => {
    const body = { model: "gemma4-12b-story-32k-ub2k", reasoning_effort: "none", messages: [] };
    applyThinking("openai", "gemma4-12b-story-32k-ub2k", body, "openai-compatible-chat-modal123");
    expect(body.reasoning_effort).toBe("none");
  });

  it("still strips for a built-in provider's non-reasoning model", () => {
    const body = { model: "gpt-4o-mini", reasoning_effort: "high", messages: [] };
    applyThinking("openai", "gpt-4o-mini", body, "openai");
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("applyThinking suffix on a compatible node", () => {
  it("a model(none) suffix turns thinking off even though the client sent nothing", () => {
    const body = { model: "gemma4-12b-story-32k-ub2k", messages: [] };
    applyThinking("openai", "gemma4-12b-story-32k-ub2k(none)", body, "openai-compatible-chat-modal123");
    expect(body.reasoning_effort).toBe("none");
  });
});

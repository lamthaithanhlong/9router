import { describe, it, expect } from "vitest";
import { modalLabel, containersForLabel, deriveState, isModalNode } from "@/lib/modalControl";

const C = (app, start = "2026-11-11 14:56:27-05:00") => ({ container_id: `ta-${app}`, app_name: app, start_time: start });

describe("modalControl", () => {
  it("reads the endpoint label from a modal.run base URL", () => {
    expect(modalLabel("https://lamthaithanhlong--ollama-gemma4-story-ollama.us-east.modal.run/v1")).toBe("ollama-gemma4-story-ollama");
    expect(modalLabel("https://api.openai.com/v1")).toBeNull();
    expect(isModalNode({ baseUrl: "https://ws--a-b.modal.run/v1" })).toBe(true);
  });

  it("matches containers to the node's own app only", () => {
    const all = [C("ollama-gemma4-story"), C("ollama-gemma4-26b"), C("ollama-gemma4")];
    expect(containersForLabel("ollama-gemma4-story-ollama", all).map((c) => c.app_name)).toEqual(["ollama-gemma4-story"]);
    expect(containersForLabel("ollama-gemma4-26b-ollama", all).map((c) => c.app_name)).toEqual(["ollama-gemma4-26b"]);
    expect(containersForLabel("ollama-gemma4-story-ollama", [C("ollama-gemma4-26b")])).toEqual([]);
  });

  it("derives the state without touching the endpoint", () => {
    const start = Date.parse("2026-11-11T19:56:27Z");
    expect(deriveState([], null)).toBe("stopped");
    expect(deriveState([], { state: "starting" })).toBe("starting");
    expect(deriveState([C("a")], { state: "starting" })).toBe("starting");
    expect(deriveState([C("a")], null)).toBe("running");
    expect(deriveState([C("a")], { state: "ready", finishedAt: start + 1000 })).toBe("ready");
    // a ready run from an older container does not make a new one ready
    expect(deriveState([C("a")], { state: "ready", finishedAt: start - 1000 })).toBe("running");
    expect(deriveState([], { state: "failed" })).toBe("failed");
    expect(deriveState([], { state: "ready", finishedAt: start })).toBe("stopped");
  });
});

import { transition } from "@/lib/modalControl";

describe("modal start/stop transitions", () => {
  const up = [{ app_name: "a", start_time: "2026-11-11 15:05:57-05:00" }];
  it("announces only real changes, never the first look after boot", () => {
    expect(transition(undefined, up)).toBeNull();
    expect(transition(undefined, [])).toBeNull();
    expect(transition({ running: false }, up)).toBe("started");
    expect(transition({ running: true }, [])).toBe("stopped");
    expect(transition({ running: true }, up)).toBeNull();
    expect(transition({ running: false }, [])).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { parseDeepSeekErrorPayload } from "../../open-sse/executors/deepseek-web.js";

describe("parseDeepSeekErrorPayload", () => {
  it("treats code 0 + data.biz_code 5 (muted account) as an error", () => {
    const parsed = parseDeepSeekErrorPayload({
      code: 0,
      msg: "",
      data: { biz_code: 5, biz_msg: "user is muted", biz_data: { is_muted: 1, mute_until: 1793244607.845 } },
    });
    expect(parsed).not.toBeNull();
    expect(parsed.muted).toBe(true);
    expect(parsed.message).toContain("user is muted");
    expect(parsed.message).toContain("2026-10-29T03:30:07");
  });

  it("still reads a non-zero top-level code", () => {
    expect(parseDeepSeekErrorPayload({ code: 40003, msg: "bad token" })).toEqual({ code: 40003, message: "bad token" });
  });

  it("passes a normal payload through", () => {
    expect(parseDeepSeekErrorPayload({ code: 0, msg: "", data: { biz_code: 0, biz_data: {} } })).toBeNull();
  });
});

// Extra headers on compatible provider nodes.
//
// Some gateways authenticate with a header the generic Bearer path cannot send
// (an activation token, a tenant id). A node may declare `extraHeaders`; these
// tests lock both the storage path and the request-time merge, plus the filter
// that keeps a crafted value from injecting a second header.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { sanitizeExtraHeaders, parseExtraHeadersInput, resolveExtraHeaders } =
  await import("@/shared/utils/extraHeaders.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

describe("sanitizeExtraHeaders", () => {
  it("parses the one-per-line form used by the dashboard", () => {
    expect(parseExtraHeadersInput("x-jg-auth: abc123\nX-Tenant: acme")).toEqual({
      "x-jg-auth": "abc123",
      "X-Tenant": "acme",
    });
  });

  it("parses a JSON object and ignores comments/blank lines", () => {
    expect(parseExtraHeadersInput('{"X-A":"1"}')).toEqual({ "X-A": "1" });
    expect(parseExtraHeadersInput("# comment\n\nX-A : 1")).toEqual({ "X-A": "1" });
    expect(parseExtraHeadersInput("")).toBeNull();
  });

  it("keeps valid headers and reports refused ones", () => {
    const { headers, errors } = sanitizeExtraHeaders({
      "x-jg-auth": "token",
      Host: "evil.example",
      "Content-Length": "999",
      Connection: "keep-alive",
    });
    expect(headers).toEqual({ "x-jg-auth": "token" });
    expect(errors).toHaveLength(3);
  });

  it("refuses CRLF in a value (header injection) and bad names", () => {
    const { headers, errors } = sanitizeExtraHeaders({
      "X-A": "value\r\nX-Injected: 1",
      "Bad Name": "v",
    });
    expect(headers).toBeNull();
    expect(errors).toHaveLength(2);
  });

  it("caps the number of headers", () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`X-${i}`, "v"]));
    const { headers, errors } = sanitizeExtraHeaders(many);
    expect(headers).toBeNull();
    expect(errors[0]).toMatch(/Too many headers/);
  });

  it("resolveExtraHeaders never throws on a corrupt stored row", () => {
    expect(resolveExtraHeaders("not-an-object")).toEqual({});
    expect(resolveExtraHeaders(null)).toEqual({});
    expect(resolveExtraHeaders({ Host: "x", "X-Ok": "1" })).toEqual({ "X-Ok": "1" });
  });
});

describe("BaseExecutor.buildHeaders — extra headers merge", () => {
  const provider = "openai-compatible-chat-abc123";
  const credentials = {
    apiKey: "k",
    providerSpecificData: { extraHeaders: { "x-jg-auth": "token", Host: "evil.example" } },
  };

  it("merges declared headers for a compatible node", () => {
    const headers = new BaseExecutor(provider, {}).buildHeaders(credentials, false);
    expect(headers["x-jg-auth"]).toBe("token");
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers.Host).toBeUndefined();
  });

  it("lets a declared header override the generic Bearer auth", () => {
    const headers = new BaseExecutor(provider, {}).buildHeaders(
      { apiKey: "k", providerSpecificData: { extraHeaders: { Authorization: "Token abc" } } },
      false,
    );
    expect(headers.Authorization).toBe("Token abc");
  });

  it("does not leak extra headers onto a non-compatible provider", () => {
    const headers = new BaseExecutor("openai", {}).buildHeaders(credentials, false);
    expect(headers["x-jg-auth"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer k");
  });
});

describe("compatible node extra headers — API round trip", () => {
  let tempDir;
  let originalDataDir;

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-extra-headers-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores declared headers on the node and copies them to the connection", async () => {
    const { POST: createConnection } = await import("@/app/api/providers/route.js");
    const { getProviderNodeById } = await import("@/models/index.js");
    const { POST: createNode } = await import("@/app/api/provider-nodes/route.js");

    const nodeRes = await createNode(new Request("https://9router.local/api/provider-nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Relay",
        prefix: "relay",
        apiType: "chat",
        baseUrl: "https://relay.example/v1",
        type: "openai-compatible",
        extraHeaders: "x-jg-auth: token\nX-Tenant: acme\nHost: evil.example",
      }),
    }));
    const { node, extraHeaderErrors } = await nodeRes.json();

    expect(node.extraHeaders).toEqual({ "x-jg-auth": "token", "X-Tenant": "acme" });
    expect(extraHeaderErrors).toHaveLength(1);

    const stored = await getProviderNodeById(node.id);
    expect(stored.extraHeaders).toEqual({ "x-jg-auth": "token", "X-Tenant": "acme" });

    const connRes = await createConnection(new Request("https://9router.local/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: node.id, apiKey: "key", name: "Relay key", defaultModel: "m" }),
    }));
    const { connection } = await connRes.json();

    expect(connection.providerSpecificData.extraHeaders).toEqual({
      "x-jg-auth": "token",
      "X-Tenant": "acme",
    });

    // The runtime reads them from the connection, which is what buildHeaders got.
    const headers = new BaseExecutor(connection.provider, {}).buildHeaders(
      { apiKey: "key", providerSpecificData: connection.providerSpecificData },
      false,
    );
    expect(headers["x-jg-auth"]).toBe("token");
  });

  it("an edit without the field leaves stored headers untouched", async () => {
    const { createProviderNode, getProviderNodeById } = await import("@/models/index.js");
    const { PUT } = await import("@/app/api/provider-nodes/[id]/route.js");

    const node = await createProviderNode({
      id: "openai-compatible-chat-keep",
      type: "openai-compatible",
      name: "Keep",
      prefix: "keep",
      apiType: "chat",
      baseUrl: "https://keep.example/v1",
      extraHeaders: { "x-jg-auth": "token" },
    });

    await PUT(new Request(`https://9router.local/api/provider-nodes/${node.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Keep renamed", prefix: "keep", apiType: "chat", baseUrl: node.baseUrl }),
    }), { params: Promise.resolve({ id: node.id }) });

    expect((await getProviderNodeById(node.id)).extraHeaders).toEqual({ "x-jg-auth": "token" });
  });

  it("an edit with an empty field clears stored headers", async () => {
    const { createProviderNode, getProviderNodeById } = await import("@/models/index.js");
    const { PUT } = await import("@/app/api/provider-nodes/[id]/route.js");

    const node = await createProviderNode({
      id: "openai-compatible-chat-clear",
      type: "openai-compatible",
      name: "Clear",
      prefix: "clear",
      apiType: "chat",
      baseUrl: "https://clear.example/v1",
      extraHeaders: { "x-jg-auth": "token" },
    });

    await PUT(new Request(`https://9router.local/api/provider-nodes/${node.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Clear", prefix: "clear", apiType: "chat", baseUrl: node.baseUrl, extraHeaders: "" }),
    }), { params: Promise.resolve({ id: node.id }) });

    expect((await getProviderNodeById(node.id)).extraHeaders).toBeUndefined();
  });
});

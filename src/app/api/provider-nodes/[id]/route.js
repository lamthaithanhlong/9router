import { NextResponse } from "next/server";
import { deleteProviderConnectionsByProvider, deleteProviderNode, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/models";
import { sanitizeExtraHeaders } from "@/shared/utils/extraHeaders";

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, prefix, apiType, baseUrl } = body;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (node.type === "openai-compatible" && (!apiType || !["chat", "responses"].includes(apiType))) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    if (!baseUrl?.trim()) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    let sanitizedBaseUrl = baseUrl.trim();
    
    // Sanitize Base URL for Anthropic Compatible
    if (node.type === "anthropic-compatible") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }
    }

    // Sanitize Base URL for Custom Embedding (strip trailing slash and /embeddings)
    if (node.type === "custom-embedding") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }
    }

    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }

    // Only compatible LLM nodes can carry extra headers. Distinguish "field
    // absent" (leave the stored headers alone) from "sent empty" (clear them),
    // otherwise any unrelated edit would silently wipe them.
    const supportsExtraHeaders = node.type === "openai-compatible" || node.type === "anthropic-compatible";
    const hasExtraHeadersField = Object.prototype.hasOwnProperty.call(body, "extraHeaders");
    const { headers: extraHeaders, errors: extraHeaderErrors } = hasExtraHeadersField
      ? sanitizeExtraHeaders(body.extraHeaders)
      : { headers: null, errors: [] };

    if (supportsExtraHeaders && hasExtraHeadersField) {
      updates.extraHeaders = extraHeaders;
    }

    const updated = await updateProviderNode(id, updates);

    const connections = await getProviderConnections({ provider: id });
    await Promise.all(connections.map((connection) => {
      const providerSpecificData = {
        ...(connection.providerSpecificData || {}),
        prefix: prefix.trim(),
        apiType: node.type === "openai-compatible" ? apiType : undefined,
        baseUrl: sanitizedBaseUrl,
        nodeName: updated.name,
      };

      if (supportsExtraHeaders && hasExtraHeadersField) {
        if (extraHeaders) providerSpecificData.extraHeaders = extraHeaders;
        else delete providerSpecificData.extraHeaders;
      }

      return updateProviderConnection(connection.id, { providerSpecificData });
    }));

    return NextResponse.json({
      node: updated,
      ...(extraHeaderErrors.length ? { extraHeaderErrors } : {}),
    });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    await deleteProviderConnectionsByProvider(id);
    await deleteProviderNode(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}

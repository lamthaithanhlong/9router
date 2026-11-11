import { NextResponse } from "next/server";
import { getProviderNodeById } from "@/models";
import { getModalStatus, isModalNode, startModalRun } from "@/lib/modalControl";

async function modalNode(params) {
  const { id } = await params;
  const node = await getProviderNodeById(id);
  if (!node) return { error: NextResponse.json({ error: "Provider node not found" }, { status: 404 }) };
  if (!isModalNode(node)) return { error: NextResponse.json({ modal: false }, { status: 400 }) };
  return { node };
}

// GET /api/provider-nodes/[id]/modal - container state from the Modal CLI; never wakes the endpoint
export async function GET(request, { params }) {
  const { node, error } = await modalNode(params);
  if (error) return error;
  return NextResponse.json(await getModalStatus(node));
}

// POST /api/provider-nodes/[id]/modal - start a container (returns at once; poll GET for the state)
export async function POST(request, { params }) {
  const { node, error } = await modalNode(params);
  if (error) return error;
  const run = startModalRun(node);
  return NextResponse.json({ run }, { status: 202 });
}

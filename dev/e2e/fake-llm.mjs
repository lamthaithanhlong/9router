// Fake OpenAI-compatible model server: drives the real Harness with scripted replies,
// no keys and no quota. Every request is logged to $E2E_DIR/requests.jsonl.
//   E2E_DIR (work dir), PORT (default 18999), SCRIPT (module whose default export decides each reply)
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const DIR = process.env.E2E_DIR;
const PORT = Number(process.env.PORT ?? 18999);
const SCRIPT = process.env.SCRIPT;
let n = 0;
const inflight = new Map();

function sse(res, model, delta, finish) {
  const chunk = (d, f) => `data: ${JSON.stringify({ id: `fake-${n}`, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
  res.write(chunk({ role: "assistant", ...delta }, null));
  res.write(chunk({}, finish));
  res.write(`data: ${JSON.stringify({ id: `fake-${n}`, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.method === "GET" && req.url.includes("/models")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ object: "list", data: ["codex-head", "manager-temp", "cursor-workers", "backup-free", "full", "deepseek-v4.1-flash"].map((id) => ({ id, object: "model" })) }));
  }
  let j = {};
  try { j = JSON.parse(body); } catch {}
  n++;
  const msgs = j.messages ?? [];
  const last = msgs.at(-1) ?? {};
  const text = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
  inflight.set(j.model, (inflight.get(j.model) ?? 0) + 1);
  res.on("close", () => inflight.set(j.model, inflight.get(j.model) - 1));
  appendFileSync(`${DIR}/requests.jsonl`, JSON.stringify({ n, model: j.model, inflight: inflight.get(j.model), nTools: (j.tools ?? []).length, toolNames: (j.tools ?? []).map((t) => t.function?.name ?? t.name), lastRole: last.role, firstUser: text(msgs.find((m) => m.role === "user")).slice(0, 300) }) + "\n");
  let reply = { content: "ok" };
  try { reply = (await import(`${SCRIPT}?t=${Date.now()}`)).default({ j, msgs, last, text }) ?? reply; } catch (e) { appendFileSync(`${DIR}/requests.jsonl`, JSON.stringify({ scriptError: String(e) }) + "\n"); }
  if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
  if (reply.error) {
    res.statusCode = reply.error.status;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: { message: reply.error.message, type: "insufficient_quota" } }));
  }
  res.setHeader("content-type", "text/event-stream");
  if (reply.tool_calls) return sse(res, j.model, { tool_calls: reply.tool_calls.map((t, i) => ({ index: i, id: `call_${n}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) }, "tool_calls");
  sse(res, j.model, { content: reply.content }, "stop");
}).listen(PORT, "127.0.0.1", () => console.log("fake llm on", PORT));

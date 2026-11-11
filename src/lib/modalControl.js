// Run button + status for a compatible node that points at a Modal web endpoint (*.modal.run).
//
// Status never touches the endpoint: any request to it resets Modal's idle timer (scaledown_window),
// so polling it would keep the GPU billed forever. It reads `modal container list --json` instead,
// which needs the Modal CLI logged in on this machine (9router runs on the same Mac).
// Run sends one GET {origin}/api/tags with the node's own headers (Modal-Key/Modal-Secret): that
// starts a container and returns once Ollama answers; Modal redirects (303) past 150 s and fetch follows.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExtraHeaders } from "@/shared/utils/extraHeaders";

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const runs = new Map(); // nodeId -> { state: "starting"|"ready"|"failed", startedAt, finishedAt, ms, error }

export function modalLabel(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    if (!host.endsWith(".modal.run")) return null;
    const first = host.split(".")[0];
    const i = first.indexOf("--");
    return i >= 0 ? first.slice(i + 2) : first;
  } catch {
    return null;
  }
}

export function isModalNode(node) {
  return !!modalLabel(node?.baseUrl);
}

// The endpoint label is "<app>-<function>"; the CLI lists app names. Longest app name that prefixes it wins.
export function containersForLabel(label, containers) {
  if (!label) return [];
  const apps = [...new Set(containers.map((c) => c.app_name))]
    .filter((a) => label.startsWith(`${a}-`))
    .sort((a, b) => b.length - a.length);
  return apps.length ? containers.filter((c) => c.app_name === apps[0]) : [];
}

export function modalCli() {
  const candidates = [process.env.MODAL_CLI, path.join(os.homedir(), ".venvs/modal/bin/modal"), "/opt/homebrew/bin/modal", "/usr/local/bin/modal"];
  return candidates.find((p) => p && existsSync(p)) || "modal";
}

function listContainers() {
  return new Promise((resolve, reject) => {
    execFile(modalCli(), ["container", "list", "--json"], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split("\n").pop()));
      try {
        resolve(JSON.parse(stdout || "[]"));
      } catch {
        reject(new Error("modal container list: bad JSON"));
      }
    });
  });
}

export function deriveState(containers, run) {
  if (run?.state === "starting") return "starting";
  if (containers.length === 0) return run?.state === "failed" ? "failed" : "stopped";
  // A container exists: ready once a run of ours got an answer after it started, else still starting
  // (or started by a chat request, which also only returns once Ollama is up).
  const since = Math.min(...containers.map((c) => Date.parse(c.start_time) || Date.now()));
  if (run?.state === "ready" && run.finishedAt >= since) return "ready";
  return "running";
}

export async function getModalStatus(node) {
  const label = modalLabel(node.baseUrl);
  const run = runs.get(node.id) || null;
  let containers = [];
  let cliError = null;
  try {
    containers = containersForLabel(label, await listContainers());
  } catch (e) {
    cliError = e.message;
  }
  return {
    modal: true,
    label,
    state: cliError ? "unknown" : deriveState(containers, run),
    containers: containers.map((c) => ({ id: c.container_id, since: c.start_time })),
    run,
    error: cliError,
  };
}

export function startModalRun(node) {
  const current = runs.get(node.id);
  if (current?.state === "starting") return current;
  const origin = new URL(node.baseUrl).origin;
  const run = { state: "starting", startedAt: Date.now() };
  runs.set(node.id, run);
  const headers = resolveExtraHeaders(node.extraHeaders);
  fetch(`${origin}/api/tags`, { headers, signal: AbortSignal.timeout(RUN_TIMEOUT_MS) })
    .then(async (res) => {
      await res.text().catch(() => "");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      Object.assign(run, { state: "ready" });
    })
    .catch((e) => Object.assign(run, { state: "failed", error: e.message }))
    .finally(() => Object.assign(run, { finishedAt: Date.now(), ms: Date.now() - run.startedAt }));
  return run;
}

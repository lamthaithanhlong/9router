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
import fs from "node:fs";
import { resolveExtraHeaders } from "@/shared/utils/extraHeaders";

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
// On globalThis: Next bundles the API route and instrumentation separately, and both must see the same runs.
const runs = (globalThis.__modalRuns ||= new Map()); // nodeId -> { state: "starting"|"ready"|"failed", startedAt, finishedAt, ms, error }

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
    .finally(() => {
      Object.assign(run, { finishedAt: Date.now(), ms: Date.now() - run.startedAt });
      const secs = Math.round(run.ms / 1000);
      notify(run.state === "ready" ? `${node.name}: ready` : `${node.name}: run failed`,
        run.state === "ready" ? `Container up after ${secs}s. Stops by itself after 20 min without requests.` : run.error,
        run.state === "ready" ? "white_check_mark" : "x");
    });
  return run;
}

// ---- Phone notifications (ntfy) --------------------------------------------------------------------
// $DATA_DIR/modal-notify.json = {"url": "https://ntfy.sh/<topic>"}; no file = no notifications.
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
const NOTIFY_FILE = path.join(DATA_DIR, "modal-notify.json");

export async function notify(title, message, tag) {
  let url;
  try {
    url = JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf8")).url;
  } catch {
    return false;
  }
  if (!url) return false;
  try {
    const u = new URL(url);
    const topic = u.pathname.replace(/^\/+|\/+$/g, "");
    // JSON publish keeps a UTF-8 title intact (HTTP header values must be ASCII).
    const res = await fetch(u.origin, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message: message || "", tags: tag ? [tag] : [] }),
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// started | stopped | null, from the last seen state and the containers listed now.
export function transition(prev, containers) {
  const running = containers.length > 0;
  if (!prev) return null; // first look after boot: remember, do not announce
  if (!prev.running && running) return "started";
  if (prev.running && !running) return "stopped";
  return null;
}

const seen = (globalThis.__modalSeen ||= new Map()); // nodeId -> { running, since }

async function watchOnce() {
  const { getProviderNodes } = await import("@/models");
  const nodes = (await getProviderNodes()).filter(isModalNode);
  if (!nodes.length) return;
  const all = await listContainers();
  for (const node of nodes) {
    const cs = containersForLabel(modalLabel(node.baseUrl), all);
    const prev = seen.get(node.id);
    const t = transition(prev, cs);
    const since = cs.length ? Math.min(...cs.map((c) => Date.parse(c.start_time) || Date.now())) : null;
    seen.set(node.id, { running: cs.length > 0, since: since ?? prev?.since });
    if (t === "started") {
      const run = runs.get(node.id);
      // the Run button announces its own "ready"; this covers a container woken by a chat request
      if (!(run && Date.now() - run.startedAt < 3 * 60 * 1000)) {
        await notify(`${node.name}: running`, "A container started (woken by a request).", "arrow_forward");
      }
    } else if (t === "stopped") {
      const mins = prev?.since ? Math.round((Date.now() - prev.since) / 60000) : null;
      await notify(`${node.name}: stopped`, mins ? `Container stopped after about ${mins} min.` : "Container stopped.", "stop_button");
    }
  }
}

export function startModalWatcher(intervalMs = 60000) {
  if (globalThis.__modalWatcher) return;
  const tick = () => watchOnce().catch(() => {});
  tick();
  globalThis.__modalWatcher = setInterval(tick, intervalMs);
  globalThis.__modalWatcher.unref?.();
}

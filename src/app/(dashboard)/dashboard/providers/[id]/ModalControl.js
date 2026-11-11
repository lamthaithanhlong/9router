"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/shared/components";

// Run button + live state for a node whose base URL is a Modal web endpoint (*.modal.run).
// Status comes from the Modal CLI on the server and never hits the endpoint, so it does not keep the GPU awake.
const LABELS = {
  stopped: ["Stopped", "default"],
  starting: ["Starting…", "warning"],
  running: ["Running", "info"],
  ready: ["Ready", "success"],
  failed: ["Run failed", "error"],
  unknown: ["Status unknown", "error"],
};

function since(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : `${m} min`;
}

export default function ModalControl({ nodeId }) {
  const [status, setStatus] = useState(null);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/provider-nodes/${nodeId}/modal`, { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      /* keep the last state */
    }
  }, [nodeId]);

  const state = status?.state || "unknown";
  useEffect(() => {
    const first = setTimeout(load, 0);
    const id = setInterval(load, state === "starting" ? 5000 : 30000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load, state]);

  const run = async () => {
    setPosting(true);
    try {
      await fetch(`/api/provider-nodes/${nodeId}/modal`, { method: "POST" });
      await load();
    } finally {
      setPosting(false);
    }
  };

  const [label, variant] = LABELS[state] || LABELS.unknown;
  const up = status?.containers?.[0];
  const detail = [
    up ? `up ${since(up.since)}` : null,
    state === "ready" && status?.run?.ms ? `cold start ${Math.round(status.run.ms / 1000)}s` : null,
    state === "failed" ? status?.run?.error : null,
    state === "unknown" ? status?.error : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="flex items-center gap-2" title="Modal container: stops by itself after 20 min without requests">
      <Badge variant={variant} size="sm" dot>{label}</Badge>
      {detail && <span className="text-xs text-text-muted">{detail}</span>}
      <Button
        size="sm"
        variant="secondary"
        icon="play_arrow"
        onClick={run}
        disabled={posting || state === "starting" || state === "ready" || state === "running"}
        className="w-full sm:w-auto"
      >
        Run
      </Button>
    </div>
  );
}

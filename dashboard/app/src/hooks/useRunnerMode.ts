import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RunnerModeResult } from "../types.js";

async function setRunnerMode(mode: string): Promise<RunnerModeResult> {
  const res = await fetch("/api/runner-mode", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (res.status === 401) {
    const err = new Error("Not signed in") as Error & { status: number };
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<RunnerModeResult>;
}

export function useRunnerMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setRunnerMode,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

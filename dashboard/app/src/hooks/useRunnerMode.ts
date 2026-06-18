import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RunnerModeResult } from "../types.js";

const ADMIN_TOKEN_KEY = "clawsweeper:admin-token";

async function requestRunnerMode(mode: string, token: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch("/api/runner-mode", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ mode }),
  });
}

async function setRunnerMode(mode: string): Promise<RunnerModeResult> {
  let token = window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  let res = await requestRunnerMode(mode, token);
  if (res.status === 401 && !token) {
    token = window.prompt("Dashboard admin token") ?? "";
    if (!token) {
      const err = new Error("Not signed in") as Error & { status: number };
      err.status = 401;
      throw err;
    }
    window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
    res = await requestRunnerMode(mode, token);
  }
  if (res.status === 401) {
    window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    const err = new Error("Unauthorized runner toggle token or session") as Error & { status: number };
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

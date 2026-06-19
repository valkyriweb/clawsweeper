import { useMutation } from "@tanstack/react-query";

export interface ClawSweeperPlanCheck {
  id: string;
  ok: boolean;
  label: string;
  detail?: string | null;
}

export interface ClawSweeperPlanResult {
  ok: boolean;
  dry_run: boolean;
  repository: string;
  repo?: {
    private: boolean;
    archived: boolean;
    default_branch: string | null;
    html_url: string | null;
  };
  checks?: ClawSweeperPlanCheck[];
  would_do?: string[];
  error?: string;
}

async function loadClawSweeperPlan(repository: string): Promise<ClawSweeperPlanResult> {
  const res = await fetch(`/api/repos/${encodeURIComponent(repository).replace("%2F", "/")}/clawsweeper-plan`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as ClawSweeperPlanResult | null;
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}: ${res.statusText}`);
  if (!body) throw new Error("empty response");
  return body;
}

export function useClawSweeperPlan() {
  return useMutation({ mutationFn: loadClawSweeperPlan });
}

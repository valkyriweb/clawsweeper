import { useMutation } from "@tanstack/react-query";

export interface ClawSweeperSetupPrResult {
  ok: boolean;
  repository: string;
  branch: string;
  existing: boolean;
  pull_request: {
    number: number | null;
    html_url: string | null;
    state: string | null;
  };
  error?: string;
}

async function createClawSweeperSetupPr(repository: string): Promise<ClawSweeperSetupPrResult> {
  const res = await fetch(
    `/api/repos/${encodeURIComponent(repository).replace("%2F", "/")}/clawsweeper-setup-pr`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    },
  );
  const body = (await res.json().catch(() => null)) as ClawSweeperSetupPrResult | null;
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}: ${res.statusText}`);
  if (!body) throw new Error("empty response");
  return body;
}

export function useClawSweeperSetupPr() {
  return useMutation({ mutationFn: createClawSweeperSetupPr });
}

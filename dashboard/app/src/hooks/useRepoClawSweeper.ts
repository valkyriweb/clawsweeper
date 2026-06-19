import { useMutation, useQueryClient } from "@tanstack/react-query";

async function setRepoClawSweeper(input: { repository: string; enabled: boolean }) {
  const res = await fetch(`/api/repos/${encodeURIComponent(input.repository).replace("%2F", "/")}/clawsweeper`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: input.enabled }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<{
    ok: boolean;
    repository: string;
    clawsweeper_enabled: boolean;
    actions_watched?: boolean;
  }>;
}

export function useRepoClawSweeper() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setRepoClawSweeper,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["repos"] });
      void client.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

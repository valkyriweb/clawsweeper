import { useMutation, useQueryClient } from "@tanstack/react-query";

async function setRepoActionsWatch(input: { repository: string; enabled: boolean }) {
  const res = await fetch(`/api/repos/${encodeURIComponent(input.repository).replace("%2F", "/")}/actions-watch`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: input.enabled }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<{ ok: boolean; repository: string; actions_watched: boolean }>;
}

export function useRepoActionsWatch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setRepoActionsWatch,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["repos"] });
      void client.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

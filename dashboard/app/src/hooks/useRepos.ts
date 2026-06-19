import { useQuery } from "@tanstack/react-query";
import type { ReposResponse } from "../types.js";

async function fetchRepos(): Promise<ReposResponse> {
  const res = await fetch(`/api/repos?ts=${Date.now()}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 401) {
    const err = new Error("401") as Error & { status: number };
    err.status = 401;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<ReposResponse>;
}

export function useRepos() {
  return useQuery<ReposResponse, Error & { status?: number }>({
    queryKey: ["repos"],
    queryFn: fetchRepos,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: (failureCount, error) => {
      if (error?.status === 401) return false;
      return failureCount < 2;
    },
  });
}

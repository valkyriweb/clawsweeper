import { useQuery } from "@tanstack/react-query";
import type { StatusResponse } from "../types.js";

async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch(`/api/status?ts=${Date.now()}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 401) {
    const err = new Error("401") as Error & { status: number };
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<StatusResponse>;
}

export function useStatus() {
  return useQuery<StatusResponse, Error & { status?: number }>({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: (failureCount, error) => {
      if (error?.status === 401) return false;
      return failureCount < 2;
    },
  });
}

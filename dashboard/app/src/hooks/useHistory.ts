import { useQuery } from "@tanstack/react-query";
import type { HistoryPage, HistorySnapshot, StoredEvent } from "../types.js";

class HistoryError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HistoryError";
    this.status = status;
  }
}

async function fetchHistory<T>(kind: "snapshots" | "events", before?: string | null): Promise<HistoryPage<T>> {
  const params = new URLSearchParams({ limit: "100" });
  if (before) params.set("before", before);
  const res = await fetch(`/api/history/${kind}?${params}`, { credentials: "include" });
  if (res.status === 401) throw new HistoryError("Not signed in", 401);
  if (!res.ok) throw new HistoryError(`HTTP ${res.status}`, res.status);
  return res.json() as Promise<HistoryPage<T>>;
}

export function useHistorySnapshots(before?: string | null) {
  return useQuery({
    queryKey: ["history", "snapshots", before ?? ""],
    queryFn: () => fetchHistory<HistorySnapshot>("snapshots", before),
    refetchInterval: before ? false : 30_000,
  });
}

export function useHistoryEvents(before?: string | null) {
  return useQuery({
    queryKey: ["history", "events", before ?? ""],
    queryFn: () => fetchHistory<StoredEvent>("events", before),
    refetchInterval: before ? false : 30_000,
  });
}

import type { PipelineItem } from "../types.js";

export function str(v: unknown): string {
  if (v == null || v === "") return "—";
  return String(v);
}

export function runId(item: PipelineItem, index: number): string {
  const id = item.id ?? item.run_id ?? item.run_number ?? `${item.repository ?? "run"}-${item.item_number ?? index}`;
  return encodeURIComponent(String(id));
}

export function runLink(item: PipelineItem): string | null {
  const u = item.run_url ?? item.item_url ?? item.url;
  return typeof u === "string" && u.length > 0 ? u : null;
}

export function itemNumber(item: PipelineItem): string {
  const n = item.number ?? item.item_number ?? item.run_number;
  return n != null ? `#${n}` : "—";
}

export function timestamp(item: PipelineItem): string | null {
  const ts = item.created_at ?? item.started_at ?? item.updated_at ?? item.timestamp;
  if (!ts) return null;
  try {
    return new Date(String(ts)).toISOString();
  } catch {
    return null;
  }
}

export function elapsed(ms: unknown): string {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const min = Math.floor(n / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

export function findRun(rows: PipelineItem[], id: string): PipelineItem | null {
  const decoded = decodeURIComponent(id);
  return rows.find((row, index) => runId(row, index) === id || String(row.id ?? "") === decoded) ?? null;
}

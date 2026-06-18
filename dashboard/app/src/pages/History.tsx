import { useState } from "react";
import { FetchError, Loading, SignInPrompt } from "../components/StateViews.js";
import { useHistoryEvents, useHistorySnapshots } from "../hooks/useHistory.js";
import type { HistorySnapshot, StoredEvent } from "../types.js";

function fmt(ts?: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().replace("T", " ").replace("Z", "").slice(0, 16);
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function miniPath(rows: HistorySnapshot[], pick: (row: HistorySnapshot) => number): string {
  const points = rows.slice().reverse();
  if (points.length === 0) return "";
  const values = points.map(pick);
  const max = Math.max(1, ...values);
  return values
    .map((v, i) => `${points.length === 1 ? 100 : (i / (points.length - 1)) * 100},${36 - (v / max) * 32}`)
    .join(" ");
}

function Sparkline({ rows, pick, color }: { rows: HistorySnapshot[]; pick: (row: HistorySnapshot) => number; color: string }) {
  const path = miniPath(rows, pick);
  return (
    <svg className="history-chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke={color} strokeWidth="2" points={path} />
    </svg>
  );
}

export function History() {
  const [snapshotCursor, setSnapshotCursor] = useState<string | null>(null);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const snapshots = useHistorySnapshots(snapshotCursor);
  const events = useHistoryEvents(eventCursor);

  const firstError = snapshots.error ?? events.error;
  if (snapshots.isLoading && events.isLoading) return <Loading />;
  if ((firstError as { status?: number } | null)?.status === 401) return <SignInPrompt />;
  if (firstError) return <FetchError message={(firstError as Error).message} />;

  const snapshotRows = snapshots.data?.rows ?? [];
  const eventRows = events.data?.rows ?? [];

  return (
    <>
      <div className="page-header">
        <h1>History</h1>
        <div className="page-meta">
          {snapshotRows.length} snapshots · {eventRows.length} events
        </div>
      </div>

      <div className="history-grid">
        <section className="history-card">
          <h2>Active runs</h2>
          <Sparkline rows={snapshotRows} color="var(--accent)" pick={(r) => n(r.fleet?.active_workflow_runs)} />
        </section>
        <section className="history-card">
          <h2>Queue depth</h2>
          <Sparkline rows={snapshotRows} color="var(--warn)" pick={(r) => n(r.fleet?.queued_workflow_runs)} />
        </section>
        <section className="history-card">
          <h2>Budget used</h2>
          <Sparkline rows={snapshotRows} color="var(--success)" pick={(r) => n(r.fleet?.budget_used_percent)} />
        </section>
        <section className="history-card">
          <h2>Failed runs</h2>
          <Sparkline rows={snapshotRows} color="var(--danger)" pick={(r) => n(r.fleet?.failed_recent_runs)} />
        </section>
      </div>

      <section className="section">
        <div className="section-title">Snapshots</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Generated</th>
                <th>Active</th>
                <th>Queued</th>
                <th>Budget</th>
                <th>Failures</th>
                <th>Diagnostics</th>
              </tr>
            </thead>
            <tbody>
              {snapshotRows.map((row: HistorySnapshot) => (
                <tr key={row._id ?? row.generatedAt}>
                  <td>{fmt(row.generatedAt)}</td>
                  <td>{n(row.fleet?.active_workflow_runs)}</td>
                  <td>{n(row.fleet?.queued_workflow_runs)}</td>
                  <td>{n(row.fleet?.budget_used_percent)}%</td>
                  <td>{n(row.fleet?.failed_recent_runs)}</td>
                  <td>{row.diagnostics?.errors?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {snapshots.data?.nextCursor && (
          <button className="pager" type="button" onClick={() => setSnapshotCursor(snapshots.data?.nextCursor ?? null)}>
            Older snapshots
          </button>
        )}
      </section>

      <section className="section">
        <div className="section-title">Events</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Repository</th>
                <th>Item</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {eventRows.map((event: StoredEvent) => (
                <tr key={event._id ?? `${event.receivedAt}-${event.itemUrl ?? event.title ?? "event"}`}>
                  <td>{fmt(event.receivedAt)}</td>
                  <td>{event.repository ?? "—"}</td>
                  <td>
                    {event.itemUrl ? (
                      <a href={event.itemUrl} target="_blank" rel="noreferrer">
                        {event.itemNumber ? `#${event.itemNumber}` : "open"}
                      </a>
                    ) : (
                      event.itemNumber ?? "—"
                    )}
                  </td>
                  <td>{event.status}</td>
                  <td>{event.stage}</td>
                  <td>{event.title ?? event.eventType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {events.data?.nextCursor && (
          <button className="pager" type="button" onClick={() => setEventCursor(events.data?.nextCursor ?? null)}>
            Older events
          </button>
        )}
      </section>
    </>
  );
}

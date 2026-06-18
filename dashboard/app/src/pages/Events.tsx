import { useStatus } from "../hooks/useStatus.js";
import { Loading, SignInPrompt, FetchError } from "../components/StateViews.js";
import { TelemetryBanner } from "../components/TelemetryBanner.js";
import type { ActivityEvent } from "../types.js";

function fmt(ts?: string): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  } catch {
    return String(ts);
  }
}

function statusClass(status?: string): string {
  const s = (status ?? "").toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "danger";
  if (s.includes("success") || s.includes("merged") || s.includes("done")) return "success";
  if (s.includes("queue") || s.includes("pending") || s.includes("progress")) return "warn";
  return "";
}

export function Events() {
  const { data, isLoading, error } = useStatus();

  if (isLoading) return <Loading />;
  if (error?.status === 401) return <SignInPrompt />;
  if (error) return <FetchError message={error.message} />;
  if (!data) return null;

  const events: ActivityEvent[] = data.recent.events ?? [];

  return (
    <>
      <div className="page-header">
        <h1>Activity</h1>
        <div className="page-meta">
          {events.length} recent event{events.length !== 1 ? "s" : ""}
        </div>
      </div>

      <TelemetryBanner errors={data.diagnostics.errors} />

      {events.length === 0 ? (
        <div className="state-box">No recent events.</div>
      ) : (
        <ul className="event-list">
          {events.map((e, i) => {
            const link = e.item_url;
            const num = e.item_number != null ? `#${e.item_number}` : "";
            const title = e.title ?? e.stage ?? "";
            const linkText = num || title || "open";
            return (
              <li key={i} className="event-row">
                <span className="event-time">{fmt(e.received_at ?? e.closed_at)}</span>
                <span className={`event-status ${statusClass(e.status)}`}>{e.status ?? e.event_type ?? "—"}</span>
                <span className="event-body">
                  <span className="event-repo">{e.repository ?? "—"}</span>{" "}
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer">
                      {linkText}
                    </a>
                  ) : (
                    <span>{linkText}</span>
                  )}{" "}
                  {num && <span className="event-title">{title}</span>}
                </span>
                {e.mode && <span className="event-mode">{e.mode}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

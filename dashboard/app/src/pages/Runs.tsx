import { useMemo } from "react";
import { useStatus } from "../hooks/useStatus.js";
import { Loading, SignInPrompt, FetchError } from "../components/StateViews.js";
import { TelemetryBanner } from "../components/TelemetryBanner.js";

function str(v: unknown): string {
  if (v == null) return "—";
  return String(v);
}

function getLink(item: Record<string, unknown>): string | null {
  const u = item["run_url"] ?? item["item_url"] ?? item["url"];
  return typeof u === "string" ? u : null;
}

function getTimestamp(item: Record<string, unknown>): string | null {
  const ts = item["created_at"] ?? item["started_at"] ?? item["updated_at"] ?? item["timestamp"];
  if (!ts) return null;
  try {
    return new Date(String(ts)).toISOString();
  } catch {
    return null;
  }
}

function getNumber(item: Record<string, unknown>): string {
  const n = item["number"] ?? item["item_number"] ?? item["run_number"];
  return n != null ? `#${n}` : "—";
}

export function Runs() {
  const { data, isLoading, error } = useStatus();

  const rows = useMemo(() => data?.pipeline ?? [], [data]);

  if (isLoading) return <Loading />;
  if (error?.status === 401) return <SignInPrompt />;
  if (error) return <FetchError message={error.message} />;
  if (!data) return null;

  return (
    <>
      <div className="page-header">
        <h1>Pipeline</h1>
        <div className="page-meta">
          {rows.length} item{rows.length !== 1 ? "s" : ""}
        </div>
      </div>

      <TelemetryBanner errors={data.diagnostics.errors} />

      {rows.length === 0 ? (
        <div className="state-box">No pipeline items.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Repository</th>
                <th>Title</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item, i) => {
                const link = getLink(item);
                const ts = getTimestamp(item);
                const title = str(item["title"] ?? item["name"]);
                return (
                  <tr key={i}>
                    <td>
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer">
                          {getNumber(item)}
                        </a>
                      ) : (
                        getNumber(item)
                      )}
                    </td>
                    <td>{str(item["repository"] ?? item["repo"])}</td>
                    <td>
                      {title === "—" ? <span style={{ color: "var(--text-muted)" }}>—</span> : title}
                    </td>
                    <td>{str(item["status"])}</td>
                    <td>{str(item["stage"] ?? item["mode"])}</td>
                    <td>{ts ? ts.replace("T", " ").replace("Z", "").slice(0, 16) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

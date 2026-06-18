import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useStatus } from "../hooks/useStatus.js";
import { Loading, SignInPrompt, FetchError } from "../components/StateViews.js";
import { TelemetryBanner } from "../components/TelemetryBanner.js";
import { itemNumber, runId, str, timestamp } from "../lib/pipeline.js";

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
                const ts = timestamp(item);
                const title = str(item.title ?? item.name);
                return (
                  <tr key={runId(item, i)}>
                    <td>
                      <Link to="/v2/runs/$runId" params={{ runId: runId(item, i) }}>
                        {itemNumber(item)}
                      </Link>
                    </td>
                    <td>{str(item.repository ?? item.repo)}</td>
                    <td>
                      {title === "—" ? <span style={{ color: "var(--text-muted)" }}>—</span> : title}
                    </td>
                    <td>{str(item.status)}</td>
                    <td>{str(item.stage ?? item.mode)}</td>
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

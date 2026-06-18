import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useStatus } from "../hooks/useStatus.js";
import { Loading, SignInPrompt, FetchError } from "../components/StateViews.js";
import { TelemetryBanner } from "../components/TelemetryBanner.js";
import { elapsed, findRun, itemNumber, runLink, str, timestamp } from "../lib/pipeline.js";

function routeRunId(): string {
  return window.location.pathname.split("/").filter(Boolean).pop() ?? "";
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function RunDetail() {
  const { data, isLoading, error } = useStatus();

  if (isLoading) return <Loading />;
  if (error?.status === 401) return <SignInPrompt />;
  if (error) return <FetchError message={error.message} />;
  if (!data) return null;

  const id = routeRunId();
  const row = findRun(data.pipeline, id);

  if (!row) {
    return (
      <>
        <div className="page-header">
          <h1>Run not found</h1>
          <div className="page-meta">Pipeline snapshots only include current active/queued items.</div>
        </div>
        <Link to="/v2/runs" className="back-link">
          ← Back to pipeline
        </Link>
      </>
    );
  }

  const ts = timestamp(row);
  const github = runLink(row);
  const ci = row.ci;
  const ciDetailsUrl = ci?.details_url ?? ci?.run_url ?? ci?.item_url;

  return (
    <>
      <div className="page-header">
        <h1>{itemNumber(row)} {str(row.title ?? row.name)}</h1>
        <div className="page-meta">
          {str(row.repository ?? row.repo)} · {str(row.stage ?? row.mode)} · {str(row.status)}
        </div>
      </div>

      <TelemetryBanner errors={data.diagnostics.errors} />

      <Link to="/v2/runs" className="back-link">
        ← Back to pipeline
      </Link>

      <div className="detail-grid">
        <section className="detail-card">
          <h2>Run</h2>
          <dl>
            <DetailRow label="Repository" value={str(row.repository ?? row.repo)} />
            <DetailRow label="Mode" value={str(row.mode)} />
            <DetailRow label="Stage" value={str(row.stage)} />
            <DetailRow label="Status" value={str(row.status)} />
            <DetailRow label="Conclusion" value={str(row.conclusion)} />
            <DetailRow label="Workflow" value={str(row.workflow)} />
            <DetailRow label="Started" value={ts ? ts.replace("T", " ").replace("Z", "") : "—"} />
            <DetailRow label="Elapsed" value={elapsed(row.elapsed_ms)} />
            <DetailRow
              label="GitHub"
              value={
                github ? (
                  <a href={github} target="_blank" rel="noreferrer">
                    Open workflow run
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </dl>
        </section>

        <section className="detail-card">
          <h2>CI signal</h2>
          <dl>
            <DetailRow label="State" value={str(ci?.state)} />
            <DetailRow label="Source" value={str(ci?.source)} />
            <DetailRow label="Label" value={str(ci?.label ?? ci?.description)} />
            <DetailRow label="Checks" value={ci ? `${ci.total ?? "—"} total · ${ci.failing ?? "—"} failing · ${ci.pending ?? "—"} pending` : "—"} />
            <DetailRow label="Head SHA" value={str(ci?.head_sha)} />
            <DetailRow label="Error" value={str(ci?.error)} />
            <DetailRow
              label="Details"
              value={
                ciDetailsUrl ? (
                  <a href={ciDetailsUrl} target="_blank" rel="noreferrer">
                    Open CI details
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </dl>
        </section>
      </div>
    </>
  );
}

import { useMemo } from "react";
import { useStatus } from "../hooks/useStatus.js";
import { Loading, SignInPrompt, FetchError } from "../components/StateViews.js";
import { TelemetryBanner } from "../components/TelemetryBanner.js";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function Overview() {
  const { data, isLoading, error } = useStatus();

  const budgetColor = useMemo(() => {
    if (!data) return "";
    const p = data.fleet.budget_used_percent;
    if (p >= 90) return "danger";
    if (p >= 70) return "warn";
    return "";
  }, [data]);

  if (isLoading) return <Loading />;
  if (error?.status === 401) return <SignInPrompt />;
  if (error) return <FetchError message={error.message} />;
  if (!data) return null;

  const { fleet, source, diagnostics, generated_at, schema_version } = data;

  return (
    <>
      <div className="page-header">
        <h1>{source.clawsweeper_repo}</h1>
        <div className="page-meta">
          v{schema_version} · updated {relativeTime(generated_at)} ({generated_at})
        </div>
      </div>

      <TelemetryBanner errors={diagnostics.errors} />

      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">Active runs</div>
          <div className="value">{fleet.active_workflow_runs}</div>
          <div className="sub">{fleet.queued_workflow_runs} queued</div>
        </div>
        <div className="stat-card">
          <div className="label">Support runs</div>
          <div className="value">{fleet.support_workflow_runs}</div>
          <div className="sub">{fleet.support_queued_workflow_runs} queued</div>
        </div>
        <div className="stat-card">
          <div className="label">Codex jobs</div>
          <div className="value">{fleet.active_codex_jobs}</div>
        </div>
        <div className="stat-card">
          <div className="label">Budget used</div>
          <div className={`value ${budgetColor}`}>{fleet.budget_used_percent}%</div>
          <div className="sub">of {fleet.worker_budget} budget</div>
        </div>
        <div className="stat-card">
          <div className="label">Failed runs</div>
          <div className={`value${fleet.failed_recent_runs > 0 ? " warn" : ""}`}>
            {fleet.failed_recent_runs}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Target repositories</div>
        <div className="chip-list">
          {source.target_repositories.map((r) => (
            <span key={r} className="chip">
              {r}
            </span>
          ))}
          {source.target_repositories.length === 0 && <span className="chip">—</span>}
        </div>
      </div>
    </>
  );
}

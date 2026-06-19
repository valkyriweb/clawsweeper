import { useMemo, useState } from "react";
import { FetchError, Loading, SignInPrompt } from "../components/StateViews.js";
import { useClawSweeperPlan } from "../hooks/useClawSweeperPlan.js";
import { useRepoActionsWatch } from "../hooks/useRepoActionsWatch.js";
import { useRepos } from "../hooks/useRepos.js";
import type { RepoInventoryItem } from "../types.js";

function fmtDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function badge(on: boolean, label: string) {
  return <span className={`pill ${on ? "ok" : "muted"}`}>{label}</span>;
}

export function Repos() {
  const { data, isLoading, error } = useRepos();
  const actionsWatch = useRepoActionsWatch();
  const clawsweeperPlan = useClawSweeperPlan();
  const [owner, setOwner] = useState("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.repos ?? []).filter((repo) => {
      if (owner !== "all" && repo.owner !== owner) return false;
      if (q && !repo.full_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data?.repos, owner, query]);

  if (isLoading) return <Loading />;
  if (error?.status === 401) return <SignInPrompt />;
  if (error) return <FetchError message={error.message} />;
  if (!data) return null;

  const watched = data.repos.filter((repo) => repo.actions_watched).length;
  const enabled = data.repos.filter((repo) => repo.clawsweeper_enabled).length;

  function toggleActionsWatch(repo: RepoInventoryItem) {
    const next = !repo.actions_watched;
    const verb = next ? "watch Actions for" : "stop watching Actions for";
    if (!window.confirm(`Really ${verb} ${repo.full_name}?`)) return;
    actionsWatch.mutate({ repository: repo.full_name, enabled: next });
  }

  function planClawSweeper(repo: RepoInventoryItem) {
    clawsweeperPlan.mutate(repo.full_name);
  }

  return (
    <>
      <div className="page-header">
        <h1>Repositories</h1>
        <div className="page-meta">
          {data.repos.length} GitHub App repos · {watched} watched · {enabled} ClawSweeper targets
        </div>
      </div>

      <div className="banner info">
        <div className="banner-title">Audited controls</div>
        <div>
          Actions watch toggles are saved to Convex repo settings with an audit row. ClawSweeper enablement still stays disabled until the guided setup flow lands.
        </div>
      </div>

      {actionsWatch.isError && (
        <div className="banner warn" role="alert">
          <div className="banner-title">Actions watch update failed</div>
          <div className="error-text">{(actionsWatch.error as Error).message}</div>
        </div>
      )}

      {clawsweeperPlan.isError && (
        <div className="banner warn" role="alert">
          <div className="banner-title">ClawSweeper plan failed</div>
          <div className="error-text">{(clawsweeperPlan.error as Error).message}</div>
        </div>
      )}

      {clawsweeperPlan.data && (
        <div className="section plan-box">
          <div className="section-title">Enable plan: {clawsweeperPlan.data.repository}</div>
          <div className="plan-grid">
            {(clawsweeperPlan.data.checks ?? []).map((check) => (
              <div key={check.id} className={`plan-check ${check.ok ? "ok" : "warn"}`}>
                <strong>{check.ok ? "✓" : "!"} {check.label}</strong>
                {check.detail && <div className="muted-text">{check.detail}</div>}
              </div>
            ))}
          </div>
          <div className="muted-text">Would do: {(clawsweeperPlan.data.would_do ?? []).join(" · ")}</div>
        </div>
      )}

      <div className="repo-toolbar">
        <label>
          Owner
          <select value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="all">All owners</option>
            {data.owners.map((item) => (
              <option key={item.owner} value={item.owner}>
                {item.owner} ({item.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="repo name" />
        </label>
      </div>

      <div className="section">
        <div className="section-title">Repository controls ({rows.length})</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th>State</th>
                <th>Updated</th>
                <th>Actions watch</th>
                <th>ClawSweeper</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((repo: RepoInventoryItem) => (
                <tr key={repo.full_name}>
                  <td>
                    {repo.html_url ? (
                      <a href={repo.html_url} target="_blank" rel="noreferrer">
                        {repo.full_name}
                      </a>
                    ) : (
                      repo.full_name
                    )}
                    <div className="muted-text">default: {repo.default_branch ?? "—"}</div>
                  </td>
                  <td>
                    {badge(repo.app_installed, "app installed")}
                    {repo.private && badge(true, "private")}
                    {repo.archived && badge(false, "archived")}
                  </td>
                  <td>{fmtDate(repo.pushed_at ?? repo.updated_at)}</td>
                  <td>
                    {badge(repo.actions_watched, repo.actions_watched ? "watching" : "not watched")}
                    {repo.actions_watch_configured === "static" && badge(true, "static")}
                    {repo.actions_watch_configured === "setting" && badge(true, "setting")}
                    <button
                      type="button"
                      className="inline-action"
                      disabled={actionsWatch.isPending}
                      onClick={() => toggleActionsWatch(repo)}
                      title="Saved to audited Convex repo settings"
                    >
                      {repo.actions_watched ? "Stop watching" : "Watch Actions"}
                    </button>
                  </td>
                  <td>
                    {badge(repo.clawsweeper_enabled, repo.clawsweeper_enabled ? "enabled" : "disabled")}
                    <button
                      type="button"
                      className="inline-action"
                      disabled={repo.clawsweeper_enabled || clawsweeperPlan.isPending}
                      title="Dry-run setup plan; does not mutate the repository"
                      onClick={() => planClawSweeper(repo)}
                    >
                      {repo.clawsweeper_enabled ? "Enabled" : "Plan setup"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

import { useMemo, useState } from "react";
import { FetchError, Loading, SignInPrompt } from "../components/StateViews.js";
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

  return (
    <>
      <div className="page-header">
        <h1>Repositories</h1>
        <div className="page-meta">
          {data.repos.length} GitHub App repos · {watched} watched · {enabled} ClawSweeper targets
        </div>
      </div>

      <div className="banner info">
        <div className="banner-title">Safe mode</div>
        <div>
          This tab is inventory-only for now. The buttons show the intended controls; the next slice
          wires them to audited settings mutations.
        </div>
      </div>

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
                    <button type="button" className="inline-action" disabled title="Next slice: audited settings mutation">
                      {repo.actions_watched ? "Stop watching" : "Watch Actions"}
                    </button>
                  </td>
                  <td>
                    {badge(repo.clawsweeper_enabled, repo.clawsweeper_enabled ? "enabled" : "disabled")}
                    <button type="button" className="inline-action" disabled title="Next slice: guided setup + audit log">
                      {repo.clawsweeper_enabled ? "Disable" : "Enable ClawSweeper"}
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

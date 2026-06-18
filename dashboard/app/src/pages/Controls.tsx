import { useState } from "react";
import { useStatus } from "../hooks/useStatus.js";
import { useRunnerMode } from "../hooks/useRunnerMode.js";
import { Loading, SignInPrompt, FetchError } from "../components/StateViews.js";
import { TelemetryBanner } from "../components/TelemetryBanner.js";

const MODES: Array<{ id: string; label: string; desc: string }> = [
  { id: "both", label: "Both", desc: "Mac Mini + MacBook runners" },
  { id: "mac-mini", label: "Mac Mini", desc: "Mac Mini only" },
  { id: "macbook", label: "MacBook", desc: "MacBook only" },
  { id: "paused", label: "Paused", desc: "No self-hosted runners" },
];

export function Controls() {
  const { data, isLoading, error } = useStatus();
  const mutation = useRunnerMode();
  const [pending, setPending] = useState<string | null>(null);

  if (isLoading) return <Loading />;
  if (error?.status === 401) return <SignInPrompt />;
  if (error) return <FetchError message={error.message} />;
  if (!data) return null;

  const current = data.fleet.runner_config?.mode ?? "unknown";
  const labels = data.fleet.runner_config?.labels ?? [];
  const runners = data.fleet.runners ?? [];

  function apply(mode: string) {
    if (mode === current) return;
    if (!window.confirm(`Switch runner mode to "${mode}"? This changes the live fleet.`)) return;
    setPending(mode);
    mutation.mutate(mode, { onSettled: () => setPending(null) });
  }

  return (
    <>
      <div className="page-header">
        <h1>Runner controls</h1>
        <div className="page-meta">
          current mode: <strong>{current}</strong>
          {labels.length > 0 ? ` · labels: ${labels.join(", ")}` : ""}
        </div>
      </div>

      <TelemetryBanner errors={data.diagnostics.errors} />

      {mutation.isError && (
        <div className="banner warn" role="alert">
          <div className="banner-title">Runner mode change failed</div>
          <div className="error-text">{(mutation.error as Error).message}</div>
        </div>
      )}
      {mutation.isSuccess && (
        <div className="banner ok" role="status">
          Runner mode set to <strong>{mutation.data.mode}</strong>.
        </div>
      )}

      <div className="section">
        <div className="section-title">Set runner mode</div>
        <div className="mode-grid">
          {MODES.map((m) => {
            const active = m.id === current;
            const busy = pending === m.id;
            return (
              <button
                key={m.id}
                type="button"
                className={`mode-card${active ? " active" : ""}`}
                disabled={active || mutation.isPending}
                onClick={() => apply(m.id)}
              >
                <span className="mode-label">{m.label}</span>
                <span className="mode-desc">{m.desc}</span>
                {active && <span className="mode-flag">current</span>}
                {busy && <span className="mode-flag">applying…</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="section">
        <div className="section-title">Registered runners ({runners.length})</div>
        {runners.length === 0 ? (
          <div className="state-box">No runners reported.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Busy</th>
                  <th>Labels</th>
                </tr>
              </thead>
              <tbody>
                {runners.map((r, i) => (
                  <tr key={i}>
                    <td>{String(r["name"] ?? "—")}</td>
                    <td>{String(r["status"] ?? "—")}</td>
                    <td>{String(r["busy"] ?? "—")}</td>
                    <td>
                      {Array.isArray(r["labels"])
                        ? (r["labels"] as unknown[])
                            .map((l) =>
                              typeof l === "object" && l ? String((l as Record<string, unknown>)["name"]) : String(l),
                            )
                            .join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

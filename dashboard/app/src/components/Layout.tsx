import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import "../app.css";

export function Layout() {
  const { location } = useRouterState();
  const p = location.pathname;

  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Main navigation">
        <div className="app-nav-logo">ClawSweeper</div>
        <Link to="/v2" aria-current={p === "/v2" || p === "/v2/" ? "page" : undefined}>
          Overview
        </Link>
        <Link to="/v2/runs" aria-current={p.startsWith("/v2/runs") ? "page" : undefined}>
          Runs
        </Link>
        <Link to="/v2/events" aria-current={p.startsWith("/v2/events") ? "page" : undefined}>
          Activity
        </Link>
        <Link to="/v2/history" aria-current={p.startsWith("/v2/history") ? "page" : undefined}>
          History
        </Link>
        <Link to="/v2/controls" aria-current={p.startsWith("/v2/controls") ? "page" : undefined}>
          Controls
        </Link>
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

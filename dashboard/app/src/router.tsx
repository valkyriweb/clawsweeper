import { createRouter, createRootRoute, createRoute } from "@tanstack/react-router";
import { Layout } from "./components/Layout.js";
import { Overview } from "./pages/Overview.js";
import { Runs } from "./pages/Runs.js";

const rootRoute = createRootRoute({
  component: Layout,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/v2",
  component: Overview,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/v2/runs",
  component: Runs,
});

const routeTree = rootRoute.addChildren([overviewRoute, runsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App.js";
import { buildOverviewSnapshot, classifyProblems, mapEvents, normalizeClaims, normalizeSandboxes, normalizeTemplates, normalizeWarmPools } from "@agent-sandbox/dashboard-shared";

const realFetch = global.fetch;

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function mockDashboardResponses(options?: { coreOnly?: boolean; failOverview?: boolean; failClaims?: boolean }) {
  const snapshot = createFixtureSnapshot({
    capabilities: options?.coreOnly
      ? {
          claims: false,
          warmPools: false,
          templates: false,
        }
      : undefined,
  });
  const routes = new Map<string, unknown>([
    ["/api/capabilities", snapshot.capabilities],
    ["/api/overview", buildOverviewSnapshot(snapshot, new Date("2026-04-15T12:00:00Z"))],
    ["/api/sandboxes", normalizeSandboxes(snapshot, new Date("2026-04-15T12:00:00Z"))],
    ["/api/claims", normalizeClaims(snapshot, new Date("2026-04-15T12:00:00Z"))],
    ["/api/warm-pools", normalizeWarmPools(snapshot, new Date("2026-04-15T12:00:00Z"))],
    ["/api/templates", normalizeTemplates(snapshot, new Date("2026-04-15T12:00:00Z"))],
    ["/api/problems", classifyProblems(snapshot, new Date("2026-04-15T12:00:00Z"))],
  ]);

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (options?.failOverview && url === "/api/overview") {
      return new Response("boom", { status: 500 });
    }
    if (options?.failClaims && url === "/api/claims") {
      return new Response("boom", { status: 500 });
    }

    const events = mapEvents(snapshot);
    if (url.startsWith("/api/events")) {
      return new Response(JSON.stringify(events.filter((event) => url.includes(event.resourceName))), { status: 200 });
    }

    const payload = routes.get(url);
    if (payload === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
});

describe("dashboard web app", () => {
  it("renders the core-only shell with loading state and sandbox tab", async () => {
    mockDashboardResponses({ coreOnly: true });
    renderApp();

    expect(screen.getByText("Loading dashboard snapshot…")).toBeInTheDocument();
    expect(await screen.findByText("Agent Sandbox Dashboard")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sandboxes" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Claims" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Overview")).toBeInTheDocument();
    expect(screen.getByLabelText("Inventory")).toBeInTheDocument();
  });

  it("renders extension tabs, charts, filters, problems, and drawer events", async () => {
    mockDashboardResponses();
    renderApp();

    expect(await screen.findByRole("tab", { name: "Claims" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Warm Pools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Templates" })).toBeInTheDocument();
    expect(screen.getByTestId("chart-sandbox-status")).toBeInTheDocument();
    expect(screen.getByTestId("chart-template-usage")).toBeInTheDocument();
    expect(screen.getByText("Problems")).toBeInTheDocument();
    expect(screen.getAllByText("Runtime resources are missing.", { exact: false }).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("Owner Kind"), { target: { value: "claim" } });
    fireEvent.click(screen.getByText("claim-ready"));

    await waitFor(() => {
      expect(screen.getByText("Summary")).toBeInTheDocument();
      expect(screen.getByText("Events")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Claims" }));
    fireEvent.click(screen.getByText("mismatch-claim"));
    expect(await screen.findByText("Sandbox summary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Warm Pools" }));
    expect(screen.getByText("underfilled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    expect(screen.getAllByText("default false").length).toBeGreaterThan(0);
    expect(screen.getAllByText("custom").length).toBeGreaterThan(0);
  });

  it("renders an error state when the overview request fails", async () => {
    mockDashboardResponses({ failOverview: true });
    renderApp();

    expect(await screen.findByText("Dashboard snapshot failed to load.")).toBeInTheDocument();
  });

  it("renders an error state when a supported extension query fails", async () => {
    mockDashboardResponses({ failClaims: true });
    renderApp();

    expect(await screen.findByText("Dashboard snapshot failed to load.")).toBeInTheDocument();
  });
});

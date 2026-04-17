import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App.js";
import {
  buildOverviewSnapshot,
  classifyProblems,
  mapEvents,
  normalizeClaims,
  normalizeSandboxes,
  normalizeTemplates,
  normalizeWarmPools,
} from "@agent-sandbox/dashboard-shared";

const realFetch = global.fetch;
const NOW = new Date("2026-04-15T12:00:00Z");

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
    ["/api/overview", buildOverviewSnapshot(snapshot, NOW)],
    ["/api/sandboxes", normalizeSandboxes(snapshot, NOW)],
    ["/api/claims", normalizeClaims(snapshot, NOW)],
    ["/api/warm-pools", normalizeWarmPools(snapshot, NOW)],
    ["/api/templates", normalizeTemplates(snapshot, NOW)],
    ["/api/problems", classifyProblems(snapshot, NOW)],
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
  it("renders the core-only shell and sandbox tab", async () => {
    mockDashboardResponses({ coreOnly: true });
    renderApp();

    expect(screen.getByText("Loading dashboard snapshot…")).toBeInTheDocument();
    expect(await screen.findByText("Agent Sandbox")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sandboxes" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Claims" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Inventory")).toBeInTheDocument();
    expect(screen.getByLabelText("Search resources by name")).toBeInTheDocument();
  });

  it("renders extension tabs, phase breakdown, and grouped problems", async () => {
    mockDashboardResponses();
    renderApp();

    expect(await screen.findByRole("tab", { name: "Claims" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Warm Pools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Templates" })).toBeInTheDocument();
    expect(screen.getByText("Phase breakdown")).toBeInTheDocument();
    expect(screen.getByText("Problems")).toBeInTheDocument();
    // Grouped problem summaries (not per-item duplicates)
    expect(
      screen.getAllByText(/Sandbox active but runtime pod missing|Retained sandbox without running pod|Resource references a missing template|Warm pool below desired capacity|Claim readiness disagrees with runtime/).length,
    ).toBeGreaterThan(0);
  });

  it("opens a sandbox drawer with events from an inventory row", async () => {
    mockDashboardResponses();
    renderApp();

    await screen.findByRole("tab", { name: "Claims" });
    fireEvent.click(screen.getByText("claim-ready"));

    await waitFor(() => {
      expect(screen.getByText("Status")).toBeInTheDocument();
      expect(screen.getByText("Events")).toBeInTheDocument();
    });
  });

  it("expanding a problem group focuses the matching inventory row", async () => {
    mockDashboardResponses();
    renderApp();

    await screen.findByRole("tab", { name: "Claims" });
    // Scope to the Problems card; its heading is "Problems"
    const problemsCard = screen.getByText("Problems").closest("section");
    if (!problemsCard) throw new Error("Problems card not found");
    const showButton = problemsCard.querySelectorAll("button[aria-expanded='false']")[0] as HTMLElement;
    fireEvent.click(showButton);
    const openButton = problemsCard.querySelector("ul li button") as HTMLElement;
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByText("Events")).toBeInTheDocument();
    });
  });

  it("renders an error state when a supported extension query fails", async () => {
    mockDashboardResponses({ failClaims: true });
    renderApp();

    expect(await screen.findByText("Dashboard snapshot failed to load.")).toBeInTheDocument();
  });
});

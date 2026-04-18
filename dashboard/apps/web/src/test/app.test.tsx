import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function mockDashboardResponses(options?: { coreOnly?: boolean; failClaims?: boolean }) {
  const snapshot = createFixtureSnapshot(
    options?.coreOnly
      ? { capabilities: { claims: false, warmPools: false, templates: false } }
      : {},
  );
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
    if (options?.failClaims && url === "/api/claims") {
      return new Response("boom", { status: 500 });
    }
    const events = mapEvents(snapshot);
    if (url.startsWith("/api/events")) {
      return new Response(
        JSON.stringify(events.filter((event) => url.includes(event.resourceName))),
        { status: 200 },
      );
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
  it("renders the core-only shell with sandboxes nav item", async () => {
    mockDashboardResponses({ coreOnly: true });
    renderApp();

    expect(screen.getByText("Loading dashboard snapshot…")).toBeInTheDocument();
    expect(await screen.findByText("agent-sandbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sandboxes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claims" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Warm pools" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search resources by name")).toBeInTheDocument();
  });

  it("renders extension nav items and overview widgets", async () => {
    mockDashboardResponses();
    renderApp();

    expect(await screen.findByRole("button", { name: "Claims" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warm pools" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Templates" })).toBeInTheDocument();
    expect(screen.getByText("Phase breakdown")).toBeInTheDocument();
    expect(screen.getByText("Problems")).toBeInTheDocument();
  });

  it("switches to the sandboxes view via sidebar", async () => {
    mockDashboardResponses();
    renderApp();

    const sandboxesButton = await screen.findByRole("button", { name: "Sandboxes" });
    fireEvent.click(sandboxesButton);
    expect(
      screen.getByRole("heading", { level: 1, name: "Sandboxes" }),
    ).toBeInTheDocument();
  });

  it("renders an error state when a supported extension query fails", async () => {
    mockDashboardResponses({ failClaims: true });
    renderApp();

    expect(await screen.findByText("Dashboard snapshot failed to load.")).toBeInTheDocument();
    expect(screen.getByText("claims", { selector: ".font-semibold" })).toBeInTheDocument();
  });

  it("clicking a sandbox row expands the detail inline with scoped events", async () => {
    mockDashboardResponses();
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Sandboxes" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Sandboxes" })).toBeInTheDocument();
    });

    const row = await screen.findByText("claim-ready");
    fireEvent.click(row);

    const details = await screen.findAllByText("Events");
    expect(details.length).toBeGreaterThan(0);
    expect(screen.getByText(/kubectl describe sandbox/)).toBeInTheDocument();
  });

  it("clicking 'open' in Problems switches view and expands the target row", async () => {
    mockDashboardResponses();
    renderApp();

    await screen.findByRole("button", { name: "Claims" });

    const problemsSection = screen.getByRole("region", { name: "Problems" });
    const showButton = within(problemsSection).getAllByRole("button", { expanded: false })[0];
    if (!showButton) throw new Error("No collapsible problem groups rendered");
    fireEvent.click(showButton);

    const openButton = within(problemsSection).getAllByText("open")[0];
    if (!openButton) throw new Error("No open button in problem group");
    fireEvent.click(openButton.closest("button")!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /Sandboxes|Claims|Warm pools|Templates/ }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByText("Events").length).toBeGreaterThan(0);
    });
  });
});

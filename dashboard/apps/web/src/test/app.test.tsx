import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared/fixtures";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App.js";
import {
  buildOverviewSnapshot,
  buildProblemDag,
  classifyProblems,
  mapEvents,
  normalizeClaims,
  normalizeSandboxes,
  normalizeTemplates,
  normalizeWarmPools,
  type DashboardSnapshot,
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

function mockDashboardResponses(options?: { coreOnly?: boolean; failDashboard?: boolean }) {
  const snapshot = createFixtureSnapshot(
    options?.coreOnly
      ? { capabilities: { claims: false, warmPools: false, templates: false } }
      : {},
  );
  const problems = classifyProblems(snapshot, NOW);
  const dashboard: DashboardSnapshot = {
    updatedAt: NOW.toISOString(),
    identity: { user: "operator", role: "operator", namespaces: [], groups: [] },
    capabilities: snapshot.capabilities,
    controllerHealth: snapshot.controllerHealth,
    overview: buildOverviewSnapshot(snapshot, NOW),
    sandboxes: normalizeSandboxes(snapshot, NOW),
    claims: normalizeClaims(snapshot, NOW),
    warmPools: normalizeWarmPools(snapshot, NOW),
    templates: normalizeTemplates(snapshot, NOW),
    problems,
    problemDag: buildProblemDag(problems),
    events: mapEvents(snapshot),
  };

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/snapshot") {
      if (options?.failDashboard) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    }
    if (url.startsWith("/api/events")) {
      return new Response(
        JSON.stringify(dashboard.events.filter((event) => url.includes(event.resourceName))),
        { status: 200 },
      );
    }
    // History/cost endpoints aren't part of the bundle; return empty defaults
    // so the SPA's secondary queries don't trigger spurious errors in tests.
    if (url.startsWith("/api/history/metrics")) {
      return new Response(JSON.stringify({ resolution: "15s", rows: [] }), { status: 200 });
    }
    if (url.startsWith("/api/cost/snapshot")) {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
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

  it("renders an error state when the bundled snapshot query fails", async () => {
    mockDashboardResponses({ failDashboard: true });
    renderApp();

    expect(await screen.findByText("Dashboard snapshot failed to load.")).toBeInTheDocument();
    expect(screen.getByText("dashboard", { selector: ".font-semibold" })).toBeInTheDocument();
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

  it("clicking an affected resource in Problems switches view to the matching inventory", async () => {
    mockDashboardResponses();
    renderApp();

    await screen.findByRole("button", { name: "Claims" });

    const problemsSection = screen.getByRole("region", { name: "Problems" });
    // Expand the first problem row (CauseTree renders chevron buttons with
    // aria-label "Expand"; ProblemGroupCard renders aria-expanded buttons).
    const expandTargets = within(problemsSection).queryAllByLabelText("Expand");
    const fallbackTargets = within(problemsSection).queryAllByRole("button", { expanded: false });
    const expandButton = expandTargets[0] ?? fallbackTargets[0];
    if (!expandButton) throw new Error("No expand control in Problems panel");
    fireEvent.click(expandButton);

    // Click any resource link inside the expanded panel — both code paths
    // wire this to filters.focus() which switches the inventory view.
    const resourceButtons = within(problemsSection).getAllByRole("button");
    const resourceLink = resourceButtons.find((button) => /\/[\w-]+$/.test(button.textContent ?? ""));
    if (!resourceLink) throw new Error("No affected-resource link rendered");
    fireEvent.click(resourceLink);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /Sandboxes|Claims|Warm pools|Templates/ }),
      ).toBeInTheDocument();
    });
  });
});

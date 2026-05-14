import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { KpiStrip } from "../components/KpiStrip";
import { FilterProvider } from "../lib/filters";
import { NowProvider } from "../lib/now";
import type { HistorySeries, SnapshotMetricsRow } from "@agent-sandbox/dashboard-shared";

function row(partial: Partial<SnapshotMetricsRow>): SnapshotMetricsRow {
  return {
    timestampMs: Date.now(),
    totalSandboxes: 0,
    activeSandboxes: 0,
    runtimeReadySandboxes: 0,
    runtimeMissingSandboxes: 0,
    pendingClaims: 0,
    claimsWithReadinessMismatch: 0,
    warmPoolReadyTotal: 0,
    warmPoolDesiredTotal: 0,
    templatesInUse: 0,
    unmappedSandboxes: 0,
    problemErrors: 0,
    problemWarnings: 0,
    claimAgeP50: 0,
    claimAgeP95: 0,
    sandboxStartingP95: 0,
    warmPoolFillRatio: 0,
    failedPods: 0,
    controllerAvailable: 1,
    costPerHourUsd: 0,
    idleSpendPerHourUsd: 0,
    ...partial,
  };
}

function wrap(children: React.ReactNode) {
  return (
    <NowProvider>
      <FilterProvider>{children}</FilterProvider>
    </NowProvider>
  );
}

describe("KpiStrip", () => {
  it("renders the latest values across the standard KPI set", () => {
    const series: HistorySeries = {
      resolution: "15s",
      rows: [
        row({ activeSandboxes: 1, pendingClaims: 1, warmPoolFillRatio: 0.5, failedPods: 0, costPerHourUsd: 1.5 }),
        row({ activeSandboxes: 42, pendingClaims: 7, warmPoolFillRatio: 0.91, failedPods: 3, costPerHourUsd: 12.4 }),
      ],
    };
    render(wrap(<KpiStrip series={series} />));
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
    expect(screen.getByText("$12.40")).toBeInTheDocument();
  });

  it("renders zeros and placeholders when series is empty", () => {
    render(wrap(<KpiStrip series={null} />));
    // Three of the six KPIs render "0" as integers; the percentage, currency,
    // and seconds KPIs format their zero specially.
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("uses currentOverride values in place of the latest series row", () => {
    const series: HistorySeries = {
      resolution: "15s",
      rows: [row({ activeSandboxes: 99, pendingClaims: 99 })],
    };
    render(
      wrap(
        <KpiStrip
          series={series}
          currentOverride={{ activeSandboxes: 3, pendingClaims: 5, warmPoolFillRatio: 0.25 }}
        />,
      ),
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.queryByText("99")).toBeNull();
  });

  it("dims metrics flagged in dimmedMetrics and annotates the tooltip", () => {
    const series: HistorySeries = {
      resolution: "15s",
      rows: [row({ costPerHourUsd: 1.5, activeSandboxes: 2 })],
    };
    const { container } = render(
      wrap(<KpiStrip series={series} dimmedMetrics={new Set(["costPerHourUsd"])} />),
    );
    expect(container.querySelector(".opacity-60")).not.toBeNull();
    expect(container.querySelector('[title*="cluster-wide"]')).not.toBeNull();
  });
});

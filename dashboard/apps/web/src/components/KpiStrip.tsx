import type { HistorySeries, MetricKey } from "@agent-sandbox/dashboard-shared";
import { useMemo } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/Sparkline";
import { useFilters } from "@/lib/filters";

export interface KpiDescriptor {
  id: string;
  label: string;
  /** Key on SnapshotMetricsRow whose value drives the KPI. */
  metric: MetricKey;
  formatter?: (value: number) => string;
  tooltip?: string;
  /** Navigation target when the card is clicked. */
  onClick?: () => void;
}

const formatInt = (value: number) => Math.round(value).toString();
const formatPercent = (value: number) => `${Math.round(value * 100)}%`;
const formatSeconds = (value: number) => {
  if (value === 0) return "—";
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${Math.round(value / 3600)}h`;
};
const formatUsd = (value: number) => `$${value.toFixed(2)}`;

export const DEFAULT_KPIS: KpiDescriptor[] = [
  { id: "active", label: "Active Sandboxes", metric: "activeSandboxes", tooltip: "Sandboxes whose object state is active." },
  { id: "pending", label: "Pending Claims", metric: "pendingClaims", tooltip: "Claims awaiting a runtime sandbox." },
  {
    id: "warm-fill",
    label: "Warm Pool Fill",
    metric: "warmPoolFillRatio",
    formatter: formatPercent,
    tooltip: "ready_replicas / desired across all warm pools.",
  },
  {
    id: "cold-p95",
    label: "Cold-Start p95",
    metric: "sandboxStartingP95",
    formatter: formatSeconds,
    tooltip: "95th percentile sandbox age in starting state.",
  },
  { id: "failed", label: "Failed Pods", metric: "failedPods", tooltip: "Active sandboxes whose pod is missing + long-pending claims." },
  {
    id: "cost",
    label: "Cost / hour",
    metric: "costPerHourUsd",
    formatter: formatUsd,
    tooltip: "Sum of running sandbox + warm-pool resource requests × node rates.",
  },
];

export interface KpiStripProps {
  series: HistorySeries | null | undefined;
  /** Override the default KPI list. */
  kpis?: KpiDescriptor[];
  /** Override the displayed "current" value per metric. Used when a filter
   *  scopes the view to a subset of resources — the history ring stores
   *  aggregate cluster counts only, so we recompute the current value from
   *  the filtered live data. The sparkline still tracks the cluster trend. */
  currentOverride?: Partial<Record<MetricKey, number>>;
}

export function KpiStrip({ series, kpis = DEFAULT_KPIS, currentOverride }: KpiStripProps) {
  const filters = useFilters();
  const latest = series?.rows.at(-1);

  const valuesByMetric = useMemo(() => {
    const rows = series?.rows ?? [];
    const out: Record<string, number[]> = {};
    for (const kpi of kpis) {
      out[kpi.metric] = rows.map((row) => Number(row[kpi.metric]) || 0);
    }
    return out;
  }, [series, kpis]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      {kpis.map((kpi) => {
        const override = currentOverride?.[kpi.metric];
        const current = override !== undefined
          ? override
          : latest ? (Number(latest[kpi.metric]) || 0) : 0;
        const formatter = kpi.formatter ?? formatInt;
        return (
          <Card
            key={kpi.id}
            className="cursor-pointer transition hover:bg-muted/50"
            onClick={() => {
              if (kpi.onClick) {
                kpi.onClick();
                return;
              }
              if (kpi.id === "cost") filters.setView("cost");
            }}
            title={kpi.tooltip}
          >
            <CardContent className="space-y-1 p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{kpi.label}</div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-serif text-2xl leading-none">{formatter(current)}</span>
                <Sparkline values={valuesByMetric[kpi.metric] ?? []} title={kpi.tooltip ?? kpi.label} />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

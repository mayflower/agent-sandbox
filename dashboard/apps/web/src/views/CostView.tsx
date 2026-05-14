import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CostPivot } from "@/components/CostPivot";
import { IdleSpendCallout } from "@/components/IdleSpendCallout";
import { Sparkline } from "@/components/Sparkline";
import { api } from "@/lib/api";

export function CostView() {
  const snapshot = useQuery({ queryKey: ["cost-snapshot"], queryFn: api.costSnapshot, refetchInterval: 30_000 });
  const history = useQuery({
    queryKey: ["history-metrics", "cost"],
    queryFn: () => api.historyMetrics({ res: "15s" }),
    refetchInterval: 15_000,
  });
  const costSeries = history.data?.rows.map((row) => row.costPerHourUsd) ?? [];

  if (snapshot.data === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Cost view is hidden because <code className="font-mono">config/cost.yaml</code> is not present.
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4 md:p-6">
      <IdleSpendCallout snapshotCost={snapshot.data ?? null} />
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm">Total $/hour</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-serif text-3xl">${(snapshot.data?.totalUsdPerHour ?? 0).toFixed(2)}</span>
              <Sparkline values={costSeries} width={120} height={28} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm">Sandboxes</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="font-serif text-2xl">
              ${(snapshot.data?.byKind.sandboxesUsdPerHour ?? 0).toFixed(2)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm">Warm pools</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="font-serif text-2xl">
              ${(snapshot.data?.byKind.warmPoolsUsdPerHour ?? 0).toFixed(2)}
            </span>
          </CardContent>
        </Card>
      </div>
      <CostPivot />
    </div>
  );
}

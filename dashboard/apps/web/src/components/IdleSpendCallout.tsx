import type { SnapshotCost } from "@agent-sandbox/dashboard-shared";

import { Card, CardContent } from "@/components/ui/card";

const DAILY_THRESHOLD_USD = 1;

export function IdleSpendCallout({ snapshotCost }: { snapshotCost: SnapshotCost | null }) {
  if (!snapshotCost) return null;
  const dailyIdle = snapshotCost.idleUsdPerHour * 24;
  if (dailyIdle < DAILY_THRESHOLD_USD) return null;
  return (
    <Card className="surface-amber border border-amber-500/40">
      <CardContent className="p-3 text-xs text-amber-900 dark:text-amber-200">
        <strong className="font-semibold">Idle warm-pool spend:</strong>{" "}
        ${dailyIdle.toFixed(2)} / day is being burned on unused warm-pool members. Consider lowering replicas
        or adopting on-demand provisioning.
      </CardContent>
    </Card>
  );
}

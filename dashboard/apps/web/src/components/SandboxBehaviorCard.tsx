import type { SandboxBehavior } from "@agent-sandbox/dashboard-shared";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function SandboxBehaviorCard({ behavior }: { behavior: SandboxBehavior }) {
  const cpuPercent =
    behavior.cpuMilliUsed !== undefined && behavior.cpuMilliRequested
      ? Math.min(200, Math.round((behavior.cpuMilliUsed / behavior.cpuMilliRequested) * 100))
      : null;
  const memPercent =
    behavior.memoryMibUsed !== undefined && behavior.memoryMibRequested
      ? Math.min(200, Math.round((behavior.memoryMibUsed / behavior.memoryMibRequested) * 100))
      : null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Behavior
          {behavior.anomaly && <Badge tone="warning">anomaly</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-xs">
        <Row label="CPU" used={behavior.cpuMilliUsed} requested={behavior.cpuMilliRequested} unit="m" percent={cpuPercent} />
        <Row label="Memory" used={behavior.memoryMibUsed} requested={behavior.memoryMibRequested} unit="Mi" percent={memPercent} />
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  used,
  requested,
  unit,
  percent,
}: {
  label: string;
  used: number | undefined;
  requested: number | undefined;
  unit: string;
  percent: number | null;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="tabular-nums">
          {used !== undefined ? `${Math.round(used)}${unit}` : "—"}
          {requested !== undefined ? ` / ${Math.round(requested)}${unit}` : ""}
        </span>
      </div>
      {percent !== null && <Progress value={Math.min(100, percent)} />}
    </div>
  );
}

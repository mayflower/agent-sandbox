import type { TemplateBehavior } from "@agent-sandbox/dashboard-shared";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function TemplateBehaviorCard({ behavior }: { behavior: TemplateBehavior }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Template behavior</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-xs">
        <Row label="Median session" value={behavior.medianSessionSeconds} suffix="s" />
        <Row label="p95 cold start" value={behavior.p95ColdStartSeconds} suffix="s" />
        <Row label="Events (24h)" value={behavior.eventCountLast24h} suffix="" integer />
        <Row label="Failures (24h)" value={behavior.failureCountLast24h} suffix="" integer />
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  suffix,
  integer = false,
}: {
  label: string;
  value: number | undefined;
  suffix: string;
  integer?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className="tabular-nums">
        {value === undefined ? "—" : integer ? Math.round(value) : value.toFixed(1)}
        {suffix}
      </span>
    </div>
  );
}

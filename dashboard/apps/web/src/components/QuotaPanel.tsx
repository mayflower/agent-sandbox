import type { ClaimLiveView, SandboxLiveView } from "@agent-sandbox/dashboard-shared";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export interface QuotaPanelProps {
  namespaces: string[];
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  /** Optional quota config — without it we display counts only. */
  quotas?: Record<string, { maxSandboxes?: number; maxClaims?: number }>;
}

export function QuotaPanel({ namespaces, sandboxes, claims, quotas }: QuotaPanelProps) {
  if (namespaces.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Your quota</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {namespaces.map((namespace) => {
          const nsSandboxes = sandboxes.filter((s) => s.namespace === namespace);
          const nsClaims = claims.filter((c) => c.namespace === namespace);
          const quota = quotas?.[namespace];
          const maxSandboxes = quota?.maxSandboxes;
          const maxClaims = quota?.maxClaims;
          return (
            <div key={namespace} className="space-y-1 border-b pb-2 last:border-b-0">
              <div className="font-mono text-[11px] text-muted-foreground">{namespace}</div>
              <Line label="Sandboxes" value={nsSandboxes.length} {...(maxSandboxes !== undefined ? { max: maxSandboxes } : {})} />
              <Line label="Claims" value={nsClaims.length} {...(maxClaims !== undefined ? { max: maxClaims } : {})} />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Line({ label, value, max }: { label: string; value: number; max?: number }) {
  if (!max) {
    return (
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
    );
  }
  const percent = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="tabular-nums">
          {value} / {max}
        </span>
      </div>
      <Progress value={percent} />
    </div>
  );
}

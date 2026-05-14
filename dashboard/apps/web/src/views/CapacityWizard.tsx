import type { ClaimLiveView, SandboxLiveView, WarmPoolLiveView } from "@agent-sandbox/dashboard-shared";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export interface CapacityWizardProps {
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  warmPools: WarmPoolLiveView[];
}

export function CapacityWizard({ sandboxes, claims, warmPools }: CapacityWizardProps) {
  const namespaceCounts = new Map<string, { sandboxes: number; claims: number }>();
  for (const sandbox of sandboxes) {
    const entry = namespaceCounts.get(sandbox.namespace) ?? { sandboxes: 0, claims: 0 };
    entry.sandboxes += 1;
    namespaceCounts.set(sandbox.namespace, entry);
  }
  for (const claim of claims) {
    const entry = namespaceCounts.get(claim.namespace) ?? { sandboxes: 0, claims: 0 };
    entry.claims += 1;
    namespaceCounts.set(claim.namespace, entry);
  }

  return (
    <div className="space-y-3 p-4 md:p-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Capacity audit</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Warm pools</h4>
            {warmPools.length === 0 ? (
              <p className="text-xs text-muted-foreground">No warm pools defined.</p>
            ) : (
              <ul className="space-y-1">
                {warmPools.map((pool) => {
                  const percent = pool.desiredReplicas
                    ? Math.round((pool.readyReplicas / pool.desiredReplicas) * 100)
                    : 0;
                  return (
                    <li key={`${pool.namespace}/${pool.name}`} className="space-y-0.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-mono">{pool.namespace}/{pool.name}</span>
                        <span className="tabular-nums">
                          {pool.readyReplicas}/{pool.desiredReplicas}
                        </span>
                      </div>
                      <Progress value={percent} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Namespace pressure</h4>
            <ul className="space-y-0.5 text-xs">
              {[...namespaceCounts.entries()].map(([namespace, counts]) => (
                <li key={namespace} className="flex items-center justify-between font-mono">
                  <span>{namespace}</span>
                  <span className="tabular-nums">
                    sandboxes={counts.sandboxes} claims={counts.claims}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}

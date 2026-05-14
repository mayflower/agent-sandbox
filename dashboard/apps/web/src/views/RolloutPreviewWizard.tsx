import type { ClaimLiveView, SandboxLiveView, TemplateLiveView, WarmPoolLiveView } from "@agent-sandbox/dashboard-shared";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface RolloutPreviewWizardProps {
  template: TemplateLiveView;
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  warmPools: WarmPoolLiveView[];
}

export function RolloutPreviewWizard({ template, sandboxes, claims, warmPools }: RolloutPreviewWizardProps) {
  const affectedSandboxes = sandboxes.filter((s) => s.templateRef === template.name);
  const affectedClaims = claims.filter((c) => c.templateRef === template.name);
  const affectedPools = warmPools.filter((p) => p.templateRef === template.name);

  return (
    <div className="space-y-3 p-4 md:p-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Rollout preview: {template.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            The following resources would be affected by an edit to <code className="font-mono">{template.name}</code>.
            Pools with <code>updateStrategy: Recreate</code> would force restarts; <code>OnReplenish</code> would only
            affect new members.
          </p>
          <Section title="Warm pools">
            {affectedPools.map((pool) => (
              <li key={`${pool.namespace}/${pool.name}`} className="font-mono">
                {pool.namespace}/{pool.name} <Badge tone={pool.updateStrategy === "Recreate" ? "danger" : "info"}>{pool.updateStrategy}</Badge>
              </li>
            ))}
          </Section>
          <Section title={`Sandboxes (${affectedSandboxes.length})`}>
            {affectedSandboxes.slice(0, 25).map((sb) => (
              <li key={`${sb.namespace}/${sb.name}`} className="font-mono">
                {sb.namespace}/{sb.name} <Badge tone={sb.effectiveReady ? "success" : "warning"}>{sb.runtimeState}</Badge>
              </li>
            ))}
          </Section>
          <Section title={`Claims (${affectedClaims.length})`}>
            {affectedClaims.slice(0, 25).map((claim) => (
              <li key={`${claim.namespace}/${claim.name}`} className="font-mono">
                {claim.namespace}/{claim.name}
              </li>
            ))}
          </Section>
        </CardContent>
      </Card>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="space-y-0.5 text-xs">{children}</ul>
    </section>
  );
}

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyableKubectlHints } from "@/components/CopyableKubectlHints";
import { CountdownBadge } from "@/components/CountdownBadge";
import { StoryTimeline } from "@/components/StoryTimeline";
import { api } from "@/lib/api";
import { useFilters } from "@/lib/filters";

export interface SandboxStoryViewProps {
  namespace: string;
  name: string;
  onClose(): void;
}

export function SandboxStoryView({ namespace, name, onClose }: SandboxStoryViewProps) {
  const filters = useFilters();
  const timelineQuery = useQuery({
    queryKey: ["timeline", namespace, name],
    queryFn: () => api.timeline(namespace, name),
    refetchInterval: 5000,
  });
  const sandboxQuery = useQuery({
    queryKey: ["sandboxes"],
    queryFn: api.sandboxes,
    refetchInterval: 5000,
  });

  const sandbox = sandboxQuery.data?.find((entry) => entry.namespace === namespace && entry.name === name);

  return (
    <div className="space-y-3 p-4 md:p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          onClose();
          filters.setView("operator");
        }}
        className="gap-2"
      >
        <ArrowLeft className="h-4 w-4" />
        back to operator view
      </Button>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="font-mono">{namespace}/{name}</span>
            {sandbox && (
              <Badge tone={sandbox.effectiveReady ? "success" : "warning"}>
                {sandbox.objectState}/{sandbox.runtimeState}
              </Badge>
            )}
            {sandbox && <CountdownBadge until={sandbox.shutdownTime} />}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_minmax(0,18rem)]">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
            <StoryTimeline rows={timelineQuery.data?.story ?? []} />
          </div>
          <aside className="space-y-3 text-xs">
            {sandbox && (
              <section>
                <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground">Identity</h4>
                <dl className="mt-1 space-y-0.5">
                  <DescriptionRow label="Template" value={sandbox.templateRef ?? "—"} />
                  <DescriptionRow label="Owner" value={`${sandbox.ownerKind} ${sandbox.ownerName ?? ""}`.trim()} />
                  <DescriptionRow label="Pod" value={sandbox.podName ?? "—"} />
                  <DescriptionRow label="Node" value={sandbox.nodeName ?? "—"} />
                  <DescriptionRow label="Phase" value={sandbox.podPhase ?? "—"} />
                  <DescriptionRow label="Service" value={sandbox.serviceFQDN ?? sandbox.service ?? "—"} />
                  <DescriptionRow label="Pod IPs" value={sandbox.podIPs.join(", ") || "—"} />
                </dl>
              </section>
            )}
            <section>
              <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground">kubectl</h4>
              <div className="mt-1">
                <CopyableKubectlHints resourceKind="Sandbox" namespace={namespace} resourceName={name} />
              </div>
            </section>
          </aside>
        </CardContent>
      </Card>
    </div>
  );
}

function DescriptionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </div>
  );
}

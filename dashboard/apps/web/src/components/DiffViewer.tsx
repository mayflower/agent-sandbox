import type { SnapshotDiff } from "@agent-sandbox/dashboard-shared";
import { Plus, Minus, ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DiffViewer({ diff }: { diff: SnapshotDiff }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Diff <Badge tone="info">{new Date(diff.fromAt).toLocaleTimeString()}</Badge>{" "}
          <ArrowRight className="inline h-3 w-3" /> <Badge tone="info">{new Date(diff.toAt).toLocaleTimeString()}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {diff.added.length > 0 && (
          <Section title="Added" tone="success">
            {diff.added.map((ref) => (
              <Row key={`${ref.namespace}/${ref.resourceName}`} sign={<Plus className="h-3 w-3 text-emerald-500" />}>
                {ref.resourceKind} {ref.namespace}/{ref.resourceName}
              </Row>
            ))}
          </Section>
        )}
        {diff.removed.length > 0 && (
          <Section title="Removed" tone="danger">
            {diff.removed.map((ref) => (
              <Row key={`${ref.namespace}/${ref.resourceName}`} sign={<Minus className="h-3 w-3 text-rose-500" />}>
                {ref.resourceKind} {ref.namespace}/{ref.resourceName}
              </Row>
            ))}
          </Section>
        )}
        {diff.transitions.length > 0 && (
          <Section title="Transitions" tone="info">
            {diff.transitions.map((entry) => (
              <Row
                key={`${entry.namespace}/${entry.resourceName}/${entry.field}`}
                sign={<ArrowRight className="h-3 w-3 text-sky-500" />}
              >
                {entry.resourceKind} {entry.namespace}/{entry.resourceName}: {entry.field} {entry.from} → {entry.to}
              </Row>
            ))}
          </Section>
        )}
        {diff.added.length === 0 && diff.removed.length === 0 && diff.transitions.length === 0 && (
          <p className="text-muted-foreground">No changes between the two points.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; tone: "success" | "danger" | "info"; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Row({ sign, children }: { sign: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-1.5 font-mono">
      {sign}
      <span>{children}</span>
    </li>
  );
}

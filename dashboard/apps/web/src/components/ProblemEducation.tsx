import type { ProblemKind } from "@agent-sandbox/dashboard-shared";
import { lookupProblemDoc } from "@agent-sandbox/dashboard-shared";

import { Card, CardContent } from "@/components/ui/card";

export function ProblemEducation({ kind }: { kind: ProblemKind }) {
  const doc = lookupProblemDoc(kind);
  if (!doc) return null;
  return (
    <Card className="border border-dashed bg-muted/20">
      <CardContent className="space-y-2 p-3 text-xs">
        <div className="font-semibold">{doc.title}</div>
        <p className="text-muted-foreground">{doc.explanation}</p>
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          {doc.firstChecks.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

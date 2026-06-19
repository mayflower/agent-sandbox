import type { ClaimLiveView, EventView, ProblemKind } from "@agent-sandbox/dashboard-shared";
import { lookupProblemDoc } from "@agent-sandbox/dashboard-shared";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface InvestigateWizardProps {
  claim: ClaimLiveView;
  events: EventView[];
}

export function InvestigateWizard({ claim, events }: InvestigateWizardProps) {
  const relevantEvents = events.filter(
    (event) =>
      event.namespace === claim.namespace &&
      (event.resourceName === claim.name || event.resourceName === claim.sandboxName),
  );

  let suspectedKind: ProblemKind = "claim-stuck-pending";
  const reason = claim.rawReadyCondition?.reason?.toLowerCase() ?? "";
  if (reason.includes("template")) suspectedKind = "unresolved-template-link";
  else if (reason.includes("pool") || reason.includes("warm")) suspectedKind = "warm-pool-underfilled";

  const doc = lookupProblemDoc(suspectedKind);

  return (
    <div className="space-y-3 p-4 md:p-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Investigate: {claim.namespace}/{claim.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Step number={1} title="Claim status">
            <p className="font-mono text-xs">
              state: {claim.state} · template: {claim.templateRef ?? "—"} · reason: {claim.rawReadyCondition?.reason ?? "—"}
            </p>
          </Step>
          <Step number={2} title="Related events (last 15 min)">
            {relevantEvents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No events visible for this claim or its sandbox.</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {relevantEvents.slice(0, 10).map((event, index) => (
                  <li key={`${event.eventTime}:${index}`} className="font-mono">
                    [{event.type ?? "Normal"}] {event.reason ?? "Event"} — {event.message}
                  </li>
                ))}
              </ul>
            )}
          </Step>
          <Step number={3} title="Likely root cause" {...(doc?.title ? { hint: doc.title } : {})}>
            {doc && (
              <div className="space-y-1 text-xs">
                <p className="text-muted-foreground">{doc.explanation}</p>
                <ul className="list-disc pl-4">
                  {doc.firstChecks.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </Step>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ number, title, hint, children }: { number: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded border p-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold">
          <span className="mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background">
            {number}
          </span>
          {title}
        </h4>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  );
}

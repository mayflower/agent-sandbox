import type { EventView } from "@agent-sandbox/dashboard-shared";
import { useMemo } from "react";

import { useFilters } from "@/lib/filters";
import { cn, formatAge, matchesSearch } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const RECENT_EVENT_SECONDS = 15 * 60;
const MAX_EVENTS = 25;
const SANDBOX_KINDS = new Set<string>([
  "Sandbox",
  "SandboxClaim",
  "SandboxWarmPool",
  "SandboxTemplate",
]);

export function EventsFeed({ events }: { events: EventView[] }) {
  const filters = useFilters();
  const now = Date.now();
  const cutoff = now - RECENT_EVENT_SECONDS * 1000;

  const recent = useMemo(() => {
    const enriched: Array<{ event: EventView; timestamp: number }> = [];
    for (const event of events) {
      if (!SANDBOX_KINDS.has(event.resourceKind)) continue;
      if (!event.eventTime) continue;
      const timestamp = Date.parse(event.eventTime);
      if (Number.isNaN(timestamp) || timestamp < cutoff) continue;
      if (filters.namespace && event.namespace !== filters.namespace) continue;
      if (!matchesSearch(event.resourceName, event.namespace, filters.search)) continue;
      enriched.push({ event, timestamp });
    }
    enriched.sort((left, right) => right.timestamp - left.timestamp);
    return enriched.slice(0, MAX_EVENTS);
  }, [events, cutoff, filters.namespace, filters.search]);

  if (recent.length === 0) {
    return (
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span className="font-semibold uppercase tracking-wider">Recent events</span>
        <span>none · 15m</span>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-3 space-y-0 p-3 pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent events
        </CardTitle>
        <span className="text-[11px] text-muted-foreground tabular-nums">15m · {recent.length}</span>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <ul className="max-h-[18rem] space-y-1 overflow-y-auto pr-1">
          {recent.map(({ event, timestamp }, index) => {
            const warning = event.type === "Warning";
            const ageSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
            return (
              <li
                key={`${event.resourceKind}-${event.namespace}-${event.resourceName}-${event.eventTime}-${index}`}
                className="rounded-md border border-border bg-card"
              >
                <button
                  type="button"
                  onClick={() => {
                    // Don't auto-route to the inventory view: the target
                    // resource may have been deleted (events linger after a
                    // claim/sandbox is gone) and the user would land on an
                    // empty inventory tab. Just narrow the feed to this
                    // resource so they can see its full event trail.
                    filters.setNamespace(event.namespace);
                    filters.setSearch(event.resourceName);
                  }}
                  className="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                >
                  <span
                    className={cn(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      warning ? "bg-amber-500" : "bg-sky-500",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5 text-xs">
                      <span className="font-semibold">
                        {event.reason ?? event.type ?? "Event"}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {event.resourceKind} {event.resourceName}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{event.message}</div>
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {formatAge(ageSeconds)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

import type { EventView, SandboxResourceKind } from "@agent-sandbox/dashboard-shared";
import { useMemo } from "react";

import { useFilters } from "../lib/filters.js";
import { cn, formatAge, matchesSearch } from "../lib/utils.js";
import { Card, CardTitle } from "./ui/card.js";

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

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <CardTitle>Recent events</CardTitle>
        <span className="text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
          15m · {recent.length}
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No events in the last 15 minutes.</p>
      ) : (
        <ul className="mt-1.5 max-h-[18rem] space-y-1 overflow-y-auto pr-1">
          {recent.map(({ event, timestamp }, index) => {
            const warning = event.type === "Warning";
            const ageSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
            return (
              <li
                key={`${event.resourceKind}-${event.namespace}-${event.resourceName}-${event.eventTime}-${index}`}
                className="rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              >
                <button
                  type="button"
                  onClick={() =>
                    filters.focus({
                      namespace: event.namespace,
                      resourceKind: event.resourceKind as SandboxResourceKind,
                      resourceName: event.resourceName,
                    })
                  }
                  className="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
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
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {event.reason ?? event.type ?? "Event"}
                      </span>
                      <span className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {event.resourceKind} {event.resourceName}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-slate-600 dark:text-slate-400">{event.message}</div>
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
                    {formatAge(ageSeconds)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

import type { EventView } from "@agent-sandbox/dashboard-shared";
import { useMemo } from "react";

import { useFilters, type SandboxTarget } from "../lib/filters.js";
import { Badge } from "./ui/badge.js";
import { Card, CardTitle } from "./ui/card.js";

const RECENT_EVENT_SECONDS = 15 * 60;
const MAX_EVENTS = 25;
const SANDBOX_KINDS = new Set([
  "Sandbox",
  "SandboxClaim",
  "SandboxWarmPool",
  "SandboxTemplate",
]);

function eventTimestamp(event: EventView): number {
  if (!event.eventTime) return 0;
  const parsed = Date.parse(event.eventTime);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatRelative(timestamp: number, now: number): string {
  if (!timestamp) return "";
  const delta = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  return `${Math.floor(delta / 3600)}h`;
}

export function EventsFeed({ events }: { events: EventView[] }) {
  const filters = useFilters();
  const now = Date.now();
  const cutoff = now - RECENT_EVENT_SECONDS * 1000;

  const recent = useMemo(() => {
    return events
      .filter((event) => {
        if (!SANDBOX_KINDS.has(event.resourceKind)) return false;
        const timestamp = eventTimestamp(event);
        if (timestamp === 0) return false;
        if (timestamp < cutoff) return false;
        if (filters.namespace && event.namespace !== filters.namespace) return false;
        if (filters.search) {
          const needle = filters.search.toLowerCase();
          if (
            !event.resourceName.toLowerCase().includes(needle) &&
            !event.namespace.toLowerCase().includes(needle)
          ) {
            return false;
          }
        }
        return true;
      })
      .sort((left, right) => eventTimestamp(right) - eventTimestamp(left))
      .slice(0, MAX_EVENTS);
  }, [events, cutoff, filters.namespace, filters.search]);

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <CardTitle>Recent events</CardTitle>
        <span className="text-xs text-stone-500 tabular-nums">
          last 15m · {recent.length} shown
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">No recent events in the last 15 minutes.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {recent.map((event, index) => {
            const warning = event.type === "Warning";
            const target: SandboxTarget | null = SANDBOX_KINDS.has(event.resourceKind)
              ? {
                  namespace: event.namespace,
                  resourceKind: event.resourceKind as SandboxTarget["resourceKind"],
                  resourceName: event.resourceName,
                }
              : null;
            return (
              <li
                key={`${event.resourceKind}-${event.namespace}-${event.resourceName}-${event.eventTime}-${index}`}
                className="rounded-xl border border-stone-200 bg-white/70"
              >
                <button
                  type="button"
                  onClick={() => target && filters.focus(target)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-emerald-50/60 disabled:cursor-default"
                  disabled={!target}
                >
                  <Badge tone={warning ? "warning" : "info"}>{event.reason ?? event.type ?? "Event"}</Badge>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-semibold text-stone-800">
                      {event.resourceKind} {event.resourceName}
                    </div>
                    <div className="truncate text-xs text-stone-600">{event.message}</div>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-stone-500">
                    {formatRelative(eventTimestamp(event), now)}
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

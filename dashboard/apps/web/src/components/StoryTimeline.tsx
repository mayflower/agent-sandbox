import type { StoryRow } from "@agent-sandbox/dashboard-shared";
import { AlertCircle, AlertTriangle, Circle } from "lucide-react";

import { cn } from "@/lib/utils";

export function StoryTimeline({ rows }: { rows: StoryRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No events recorded yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {rows.map((row) => {
        const Icon = row.severity === "error" ? AlertCircle : row.severity === "warning" ? AlertTriangle : Circle;
        return (
          <li key={row.source.id} className="flex gap-2">
            <Icon
              className={cn(
                "mt-0.5 h-3 w-3",
                row.severity === "error" && "text-rose-500",
                row.severity === "warning" && "text-amber-500",
                row.severity === "info" && "text-sky-500",
              )}
            />
            <div className="flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{row.verb}</span>
                <time className="text-[10px] text-muted-foreground tabular-nums" dateTime={row.at}>
                  {row.at.slice(11, 19)}
                </time>
              </div>
              <p className="text-xs text-muted-foreground">{row.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

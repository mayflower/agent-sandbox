import type { HistorySeries } from "@agent-sandbox/dashboard-shared";
import { useMemo } from "react";

import { useFilters } from "@/lib/filters";

export interface TimeScrubberProps {
  series: HistorySeries | null | undefined;
}

export function TimeScrubber({ series }: TimeScrubberProps) {
  const filters = useFilters();
  const rows = series?.rows ?? [];
  const sliderMax = Math.max(0, rows.length - 1);

  const value = useMemo(() => {
    if (!filters.scrubAt) return sliderMax;
    const target = Date.parse(filters.scrubAt);
    if (Number.isNaN(target)) return sliderMax;
    let bestIdx = sliderMax;
    let bestDelta = Number.POSITIVE_INFINITY;
    rows.forEach((row, index) => {
      const delta = Math.abs(row.timestampMs - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = index;
      }
    });
    return bestIdx;
  }, [filters.scrubAt, rows, sliderMax]);

  if (rows.length < 2) {
    return null;
  }
  const activeRow = rows[value];
  const live = value === sliderMax;

  function setAt(index: number) {
    const row = rows[index];
    if (!row) return;
    if (index === sliderMax) {
      filters.setScrubAt("");
    } else {
      filters.setScrubAt(new Date(row.timestampMs).toISOString());
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1.5 text-[11px]">
      <span className="font-semibold uppercase tracking-wide text-muted-foreground">Time</span>
      <input
        type="range"
        min={0}
        max={sliderMax}
        value={value}
        onChange={(event) => setAt(Number(event.target.value))}
        className="h-1 flex-1"
        aria-label="Time scrubber"
      />
      <span className="tabular-nums">
        {activeRow ? new Date(activeRow.timestampMs).toLocaleTimeString() : "—"}
      </span>
      <button
        type="button"
        className="rounded border px-1.5 py-0.5"
        onClick={() => setAt(sliderMax)}
        disabled={live}
      >
        live
      </button>
    </div>
  );
}

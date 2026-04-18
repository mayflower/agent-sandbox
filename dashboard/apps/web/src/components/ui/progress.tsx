import { formatPercent } from "../../lib/utils.js";

export function Progress({ value }: { value: number }) {
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
        <div
          className="h-full rounded bg-slate-700 dark:bg-slate-300"
          style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
        />
      </div>
      <div className="text-xs text-slate-600 dark:text-slate-400">{formatPercent(value)}</div>
    </div>
  );
}

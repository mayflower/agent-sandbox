import { formatPercent } from "../../lib/utils.js";

export function Progress({ value }: { value: number }) {
  return (
    <div className="space-y-1">
      <div className="h-2 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
      </div>
      <div className="text-xs text-stone-600">{formatPercent(value)}</div>
    </div>
  );
}

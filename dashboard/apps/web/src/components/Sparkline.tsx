import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Optional title (also serves as tooltip text). */
  title?: string;
}

export function Sparkline({ values, width = 80, height = 20, className, title }: SparklineProps) {
  const path = useMemo(() => buildPath(values, width, height), [values, width, height]);
  const trend = useMemo(() => trendArrow(values), [values]);

  if (values.length === 0) {
    return <span className={cn("inline-block text-xs text-muted-foreground", className)}>—</span>;
  }

  return (
    <svg
      role="img"
      aria-label={title ?? "trend"}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("text-foreground/70", className)}
    >
      {title ? <title>{title}</title> : null}
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.25} />
      {trend && (
        <text x={width - 4} y={height - 2} textAnchor="end" fontSize={9} fill="currentColor">
          {trend}
        </text>
      )}
    </svg>
  );
}

function buildPath(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = height / 2;
    return `M0,${y} L${width},${y}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / span) * (height - 2) - 1;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function trendArrow(values: number[]): string | null {
  if (values.length < 2) return null;
  const first = values[0]!;
  const last = values.at(-1)!;
  const delta = last - first;
  const pct = first === 0 ? (delta > 0 ? Infinity : 0) : Math.abs(delta / first);
  if (pct < 0.05) return null;
  return delta > 0 ? "↑" : "↓";
}

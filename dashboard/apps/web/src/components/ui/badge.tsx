import type { PropsWithChildren } from "react";

import { cn } from "../../lib/utils.js";

export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "success" | "warning" | "danger" | "info" }>) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide",
        tone === "neutral" && "border-stone-300 bg-stone-100 text-stone-700",
        tone === "success" && "border-emerald-300 bg-emerald-100 text-emerald-800",
        tone === "warning" && "border-amber-300 bg-amber-100 text-amber-800",
        tone === "danger" && "border-rose-300 bg-rose-100 text-rose-800",
        tone === "info" && "border-cyan-300 bg-cyan-100 text-cyan-900",
      )}
    >
      {children}
    </span>
  );
}

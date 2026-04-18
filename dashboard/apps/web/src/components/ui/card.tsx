import type { ComponentPropsWithoutRef, PropsWithChildren } from "react";

import { cn } from "../../lib/utils.js";

export function Card({
  children,
  className,
  ...props
}: PropsWithChildren<ComponentPropsWithoutRef<"section">>) {
  return (
    <section
      className={cn(
        "rounded-md border border-slate-200 bg-white p-3 shadow-panel",
        "dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <h2
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400",
        className,
      )}
    >
      {children}
    </h2>
  );
}

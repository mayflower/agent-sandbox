import type { ComponentPropsWithoutRef, PropsWithChildren } from "react";

import { cn } from "../../lib/utils.js";

export function Card({
  children,
  className,
  ...props
}: PropsWithChildren<ComponentPropsWithoutRef<"section">>) {
  return (
    <section
      className={cn("rounded-xl border border-slate-200 bg-white p-4 shadow-panel", className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <h2 className={cn("text-sm font-semibold uppercase tracking-wide text-slate-700", className)}>{children}</h2>;
}

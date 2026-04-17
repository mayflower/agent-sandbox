import type { ComponentPropsWithoutRef, PropsWithChildren } from "react";

import { cn } from "../../lib/utils.js";

export function Card({
  children,
  className,
  ...props
}: PropsWithChildren<ComponentPropsWithoutRef<"section">>) {
  return (
    <section
      className={cn("rounded-3xl border border-emerald-200/70 bg-panel/95 p-5 shadow-panel", className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <h2 className={cn("font-display text-xl text-ink", className)}>{children}</h2>;
}

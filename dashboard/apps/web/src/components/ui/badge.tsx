import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      tone: {
        neutral:
          "border-border bg-muted text-muted-foreground",
        success:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        warning:
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        danger:
          "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        info:
          "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

const DOT_CLASSES: Record<NonNullable<VariantProps<typeof badgeVariants>["tone"]>, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  info: "bg-sky-500",
  outline: "bg-foreground",
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

function Badge({ className, tone, dot = false, children, ...props }: BadgeProps) {
  const resolvedTone = tone ?? "neutral";
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && (
        <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[resolvedTone])} aria-hidden />
      )}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };

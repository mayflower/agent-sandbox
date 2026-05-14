import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

export interface EmptyStateProps {
  title: string;
  description: string;
  /** Optional next-step prompts. Each must include text + onClick. */
  nextSteps?: Array<{ label: string; onClick: () => void }>;
  icon?: ReactNode;
}

export function EmptyState({ title, description, nextSteps = [], icon }: EmptyStateProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-2 p-4 text-center">
        <div className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          {icon ?? <Sparkles className="h-5 w-5 text-muted-foreground" />}
        </div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
        {nextSteps.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            {nextSteps.map((step) => (
              <button
                key={step.label}
                type="button"
                onClick={step.onClick}
                className="rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
              >
                {step.label}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

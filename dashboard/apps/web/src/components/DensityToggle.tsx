import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { loadDensity, saveDensity, type Density } from "@/lib/saved-views";
import { cn } from "@/lib/utils";

const OPTIONS: Density[] = ["compact", "comfortable", "card"];

export function DensityToggle() {
  const [density, setDensity] = useState<Density>(() => loadDensity());

  useEffect(() => {
    document.documentElement.dataset["density"] = density;
    saveDensity(density);
  }, [density]);

  return (
    <div className="inline-flex items-center gap-0.5 rounded border bg-background p-0.5 text-[10px]">
      {OPTIONS.map((option) => (
        <Button
          key={option}
          variant="ghost"
          size="sm"
          className={cn("h-5 px-1.5 text-[10px]", density === option && "bg-muted")}
          onClick={() => setDensity(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

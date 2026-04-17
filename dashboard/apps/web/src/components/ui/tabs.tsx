import { cn } from "../../lib/utils.js";

export interface TabDef {
  key: string;
  label: string;
}

export function Tabs({
  active,
  onChange,
  tabs,
}: {
  active: string;
  onChange: (key: string) => void;
  tabs: TabDef[];
}) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Inventory Tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={active === tab.key}
          className={cn(
            "rounded-full border px-4 py-2 text-sm font-semibold transition",
            active === tab.key
              ? "border-accent bg-accent text-white"
              : "border-emerald-200 bg-white/80 text-ink hover:border-accent hover:text-accent",
          )}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

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
    <div
      className="flex flex-wrap gap-x-1 border-b border-slate-200 dark:border-slate-800"
      role="tablist"
      aria-label="Inventory Tabs"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={active === tab.key}
          className={cn(
            "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition",
            active === tab.key
              ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
              : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
          )}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

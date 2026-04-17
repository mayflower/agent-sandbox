import type { PropsWithChildren } from "react";

import { cn } from "../../lib/utils.js";

export function Drawer({
  children,
  open,
  title,
  onClose,
}: PropsWithChildren<{ open: boolean; title: string; onClose: () => void }>) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm">
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-stone-200 bg-panel p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-2xl text-ink">{title}</h2>
          <button className="rounded-full border border-stone-300 px-3 py-1 text-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className={cn("space-y-5")}>{children}</div>
      </aside>
    </div>
  );
}

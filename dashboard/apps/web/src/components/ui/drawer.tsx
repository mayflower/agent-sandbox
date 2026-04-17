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
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} details`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-200 bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-2xl text-slate-900">{title}</h2>
          <button
            type="button"
            className="rounded-full border border-slate-300 px-3 py-1 text-sm hover:bg-white"
            onClick={onClose}
            aria-label="Close detail panel"
          >
            Close
          </button>
        </div>
        <div className={cn("space-y-5")}>{children}</div>
      </aside>
    </div>
  );
}

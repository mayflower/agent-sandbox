import { useState, type ReactNode } from "react";

import { cn } from "../lib/utils.js";

interface ActionButtonProps {
  label: string;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | unknown;
  disabled?: boolean;
  tone?: "danger" | "neutral";
  icon?: ReactNode;
  pending?: boolean;
}

export function ActionButton({
  label,
  confirmLabel = "Click again to confirm",
  onConfirm,
  disabled,
  tone = "neutral",
  pending,
}: ActionButtonProps) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const baseClass =
    "inline-flex items-center gap-2 rounded border px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const toneClass =
    tone === "danger"
      ? "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-900/40 dark:text-rose-200 dark:hover:bg-rose-900/60"
      : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
  const armedClass =
    tone === "danger"
      ? "border-rose-600 bg-rose-600 text-white hover:bg-rose-700"
      : "border-slate-900 bg-slate-900 text-white hover:bg-slate-800 dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-slate-100";

  const handleClick = async () => {
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex flex-col gap-1">
      <div className="inline-flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || busy || pending}
          onClick={handleClick}
          className={cn(baseClass, armed ? armedClass : toneClass)}
        >
          {busy || pending ? "Working…" : armed ? confirmLabel : label}
        </button>
        {armed && (
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            cancel
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-rose-700 dark:text-rose-300">{error}</p>}
    </div>
  );
}

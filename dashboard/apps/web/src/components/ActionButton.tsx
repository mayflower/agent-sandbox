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
    "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium border transition disabled:cursor-not-allowed disabled:opacity-50";
  const toneClass =
    tone === "danger"
      ? "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100"
      : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50";
  const armedClass =
    tone === "danger"
      ? "border-rose-600 bg-rose-600 text-white hover:bg-rose-700"
      : "border-slate-900 bg-slate-900 text-white hover:bg-slate-800";

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
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            cancel
          </button>
        )}
      </div>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}

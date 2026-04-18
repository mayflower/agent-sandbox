import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

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

  const variant: "destructive" | "secondary" | "default" = tone === "danger"
    ? armed
      ? "destructive"
      : "destructive"
    : armed
      ? "default"
      : "secondary";

  return (
    <div className="inline-flex flex-col gap-1">
      <div className="inline-flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={variant}
          disabled={disabled || busy || pending}
          onClick={handleClick}
          className={tone === "danger" && !armed ? "bg-destructive/80 hover:bg-destructive" : undefined}
        >
          {busy || pending ? "Working…" : armed ? confirmLabel : label}
        </Button>
        {armed && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setArmed(false)}>
            cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

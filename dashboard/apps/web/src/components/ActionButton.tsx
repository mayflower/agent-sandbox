import { useEffect, useRef, useState, type ReactNode } from "react";

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
  const armedTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (armedTimer.current !== null) {
        window.clearTimeout(armedTimer.current);
        armedTimer.current = null;
      }
    };
  }, []);

  const handleClick = async () => {
    if (!armed) {
      setArmed(true);
      if (armedTimer.current !== null) {
        window.clearTimeout(armedTimer.current);
      }
      armedTimer.current = window.setTimeout(() => {
        setArmed(false);
        armedTimer.current = null;
      }, 4000);
      return;
    }
    setArmed(false);
    if (armedTimer.current !== null) {
      window.clearTimeout(armedTimer.current);
      armedTimer.current = null;
    }
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("ActionButton onConfirm failed", err);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const variant: "destructive" | "default" | "secondary" =
    tone === "danger" ? "destructive" : armed ? "default" : "secondary";

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
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

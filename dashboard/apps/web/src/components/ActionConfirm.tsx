import { useEffect, useRef, useState } from "react";
import { Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ActionConfirmProps {
  label: string;
  tone?: "default" | "danger";
  /** Disables undo for irreversible actions (e.g. delete). */
  irreversible?: boolean;
  /** Window (ms) during which the action can be cancelled before it fires. */
  undoWindowMs?: number;
  disabled?: boolean;
  onConfirm(): Promise<void> | void;
}

export function ActionConfirm({
  label,
  tone = "default",
  irreversible = false,
  undoWindowMs = 5000,
  disabled,
  onConfirm,
}: ActionConfirmProps) {
  const [phase, setPhase] = useState<"idle" | "armed" | "running">("idle");
  const [remaining, setRemaining] = useState(0);
  const fireRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (fireRef.current !== null) window.clearTimeout(fireRef.current);
    };
  }, []);

  function arm() {
    if (irreversible) {
      void run();
      return;
    }
    setPhase("armed");
    setRemaining(undoWindowMs);
    const start = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const left = Math.max(0, undoWindowMs - elapsed);
      setRemaining(left);
      if (left === 0) window.clearInterval(tick);
    }, 250);
    fireRef.current = window.setTimeout(() => {
      window.clearInterval(tick);
      void run();
    }, undoWindowMs);
  }

  async function run() {
    setPhase("running");
    try {
      await onConfirm();
    } finally {
      setPhase("idle");
    }
  }

  function cancel() {
    if (fireRef.current !== null) window.clearTimeout(fireRef.current);
    fireRef.current = null;
    setPhase("idle");
  }

  if (phase === "armed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-xs">
        firing in {Math.ceil(remaining / 1000)}s …
        <Button type="button" size="sm" variant="ghost" className="h-6 gap-1" onClick={cancel}>
          <Undo2 className="h-3 w-3" />
          undo
        </Button>
      </span>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant={tone === "danger" ? "destructive" : "outline"}
      onClick={arm}
      disabled={disabled || phase === "running"}
      className={cn(tone === "danger" && "border-rose-500/30")}
    >
      {phase === "running" ? "…" : label}
    </Button>
  );
}

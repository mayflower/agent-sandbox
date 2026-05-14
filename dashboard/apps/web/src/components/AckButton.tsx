import { useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ackProblem, clearAck } from "@/lib/saved-views";

export interface AckButtonProps {
  kind: string;
  acked: boolean;
  /** Called after an ack mutation succeeds with the next acks set. */
  onAck(): void;
}

export function AckButton({ kind, acked, onAck }: AckButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (acked) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          clearAck(kind);
          onAck();
        }}
        className="gap-1"
        title="Clear acknowledgement"
      >
        <ShieldCheck className="h-3 w-3" />
        ack
      </Button>
    );
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} className="gap-1">
        <Check className="h-3 w-3" />
        ack 1h
      </Button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="reason (optional)"
        className="h-6 rounded border bg-background px-1 text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 px-1"
        onClick={() => {
          ackProblem(kind, reason);
          setOpen(false);
          setReason("");
          onAck();
        }}
      >
        <Check className="h-3 w-3" />
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-6 px-1" onClick={() => setOpen(false)}>
        <X className="h-3 w-3" />
      </Button>
    </span>
  );
}

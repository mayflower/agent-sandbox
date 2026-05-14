import { useState } from "react";
import { Copy, Check } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface CopyableKubectlHintsProps {
  resourceKind: "Sandbox" | "SandboxClaim" | "SandboxWarmPool" | "SandboxTemplate" | "Pod";
  namespace: string;
  resourceName: string;
}

const PLURAL: Record<CopyableKubectlHintsProps["resourceKind"], string> = {
  Sandbox: "sandboxes",
  SandboxClaim: "sandboxclaims",
  SandboxWarmPool: "sandboxwarmpools",
  SandboxTemplate: "sandboxtemplates",
  Pod: "pods",
};

export function CopyableKubectlHints({ resourceKind, namespace, resourceName }: CopyableKubectlHintsProps) {
  const plural = PLURAL[resourceKind];
  const commands = [
    `kubectl describe ${plural.slice(0, -1)} -n ${namespace} ${resourceName}`,
    `kubectl get ${plural} -n ${namespace} ${resourceName} -o yaml`,
    `kubectl get events -n ${namespace} --field-selector involvedObject.name=${resourceName}`,
  ];
  return (
    <div className="space-y-1">
      {commands.map((cmd) => (
        <CopyLine key={cmd} text={cmd} />
      ))}
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex items-center gap-2 rounded border bg-muted/30 p-1.5 text-[11px] font-mono">
      <code className="flex-1 truncate">{text}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        onClick={() => {
          navigator.clipboard.writeText(text).then(
            () => {
              setState("copied");
              setTimeout(() => setState("idle"), 1500);
            },
            () => {
              setState("failed");
              setTimeout(() => setState("idle"), 2000);
            },
          );
        }}
        aria-label="Copy command"
        title={state === "failed" ? "Copy failed — clipboard permission denied" : "Copy command"}
      >
        {state === "copied" ? (
          <Check className="h-3 w-3" />
        ) : state === "failed" ? (
          <span className="text-[10px] text-rose-500">!</span>
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}

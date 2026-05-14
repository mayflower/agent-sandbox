import type { ProblemDoc, ProblemKind } from "./types.js";

export const PROBLEM_DOCS: Record<ProblemKind, ProblemDoc> = {
  "runtime-missing": {
    kind: "runtime-missing",
    title: "Runtime pod missing for active sandbox",
    explanation:
      "The Sandbox object exists and is not expired but no Pod backs it. The controller normally provisions a Pod within seconds; persistent absence indicates a scheduling or admission failure.",
    firstChecks: [
      "Inspect Events for the namespace — look for FailedScheduling or admission rejections.",
      "Check whether the referenced SandboxTemplate still exists.",
      "Verify node capacity matches the template's resource requests.",
    ],
  },
  "retained-without-runtime": {
    kind: "retained-without-runtime",
    title: "Retained sandbox no longer has a pod",
    explanation:
      "The sandbox passed its shutdownTime with shutdownPolicy=Retain. The CRD stays, the Pod is gone. Expected after retention, but the workspace is unreachable until restarted.",
    firstChecks: [
      "If retention is intentional, no action needed.",
      "Otherwise extend the lifecycle via the claim or recreate the sandbox.",
    ],
  },
  "claim-runtime-mismatch": {
    kind: "claim-runtime-mismatch",
    title: "Claim readiness disagrees with the runtime",
    explanation:
      "The SandboxClaim reports Ready=True or Ready=False that does not match whether the underlying Pod is actually Ready. Typically a controller lag or stale conditions after a manual edit.",
    firstChecks: [
      "Inspect the claim's status.conditions vs the sandbox's status.conditions.",
      "Trigger a reconcile and watch whether the claim catches up within 30 s.",
    ],
  },
  "warm-pool-underfilled": {
    kind: "warm-pool-underfilled",
    title: "Warm pool below desired ready replicas",
    explanation:
      "readyReplicas < spec.replicas. New claims will wait for cold-start. Common causes: template change, image pull failure, scheduling pressure.",
    firstChecks: [
      "Open the warm pool drawer to see creating vs failed counts.",
      "Tail Events on the warm-pool namespace for ImagePullBackOff or FailedCreate.",
    ],
  },
  "unresolved-template-link": {
    kind: "unresolved-template-link",
    title: "Resource references a missing SandboxTemplate",
    explanation:
      "A claim, sandbox or warm pool references a SandboxTemplate that the dashboard cannot see. Either the template was deleted or it lives in a namespace the operator scope excludes.",
    firstChecks: [
      "Recreate the SandboxTemplate or restore from a known-good manifest.",
      "Confirm the dashboard scope includes the template's namespace.",
    ],
  },
  "sandbox-stuck-starting": {
    kind: "sandbox-stuck-starting",
    title: "Sandbox stuck starting",
    explanation:
      "Pod has existed for ≥5 minutes without reaching Ready. Almost always image-pull, init-container, or readiness-probe related.",
    firstChecks: [
      "Pod events: look for ImagePullBackOff, CrashLoopBackOff, FailedPostStartHook.",
      "Inspect the readiness probe vs actual container startup time.",
    ],
  },
  "sandbox-stuck-terminating": {
    kind: "sandbox-stuck-terminating",
    title: "Sandbox stuck terminating",
    explanation:
      "DeletionTimestamp is set but the Pod has not gone away. Usually a finalizer or a hanging preStop hook.",
    firstChecks: [
      "Inspect metadata.finalizers on the sandbox.",
      "Force-delete the pod if the preStop hook is the culprit (last resort).",
    ],
  },
  "claim-stuck-pending": {
    kind: "claim-stuck-pending",
    title: "Claim pending for an unusually long time",
    explanation:
      "Claim was created ≥5 minutes ago without an assigned sandbox. The claim is waiting on a warm-pool slot, on the controller, or on its template.",
    firstChecks: [
      "Inspect the claim's status.conditions[Ready].reason — it usually states why.",
      "Check the warm pool referenced (if any) for fill deficit.",
      "Check whether the referenced template exists.",
    ],
  },
};

export function lookupProblemDoc(kind: ProblemKind): ProblemDoc | undefined {
  return PROBLEM_DOCS[kind];
}

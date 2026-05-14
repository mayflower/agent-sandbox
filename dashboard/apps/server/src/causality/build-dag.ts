import {
  buildProblemDag,
  classifyProblems,
  type InventorySnapshot,
  type ProblemDag,
} from "@agent-sandbox/dashboard-shared";

/** Server-side facade that attaches the DAG to a snapshot. */
export function buildSnapshotProblemDag(snapshot: InventorySnapshot, now = new Date()): ProblemDag {
  const problems = classifyProblems(snapshot, now);
  return buildProblemDag(problems);
}

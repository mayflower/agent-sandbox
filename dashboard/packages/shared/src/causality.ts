import type {
  ProblemDag,
  ProblemKind,
  ProblemNode,
  ProblemView,
  SandboxResourceKind,
} from "./types.js";

interface CausalityRule {
  /** Apply when this kind is present in the problem list. */
  childKind: ProblemKind;
  /** The parent kind whose presence makes the child a downstream effect. */
  parentKind: ProblemKind;
  /** Optional matcher to scope the parent within the same namespace/template. */
  match?: (child: ProblemView, parent: ProblemView) => boolean;
}

const SAME_NAMESPACE = (child: ProblemView, parent: ProblemView): boolean =>
  child.namespace === parent.namespace;

const RULES: CausalityRule[] = [
  {
    childKind: "runtime-missing",
    parentKind: "unresolved-template-link",
    match: SAME_NAMESPACE,
  },
  {
    childKind: "claim-stuck-pending",
    parentKind: "warm-pool-underfilled",
    match: SAME_NAMESPACE,
  },
  {
    childKind: "claim-stuck-pending",
    parentKind: "unresolved-template-link",
    match: SAME_NAMESPACE,
  },
  {
    childKind: "claim-runtime-mismatch",
    parentKind: "runtime-missing",
    match: SAME_NAMESPACE,
  },
  {
    childKind: "sandbox-stuck-starting",
    parentKind: "warm-pool-underfilled",
    match: SAME_NAMESPACE,
  },
  {
    childKind: "retained-without-runtime",
    parentKind: "unresolved-template-link",
    match: SAME_NAMESPACE,
  },
];

function problemId(problem: ProblemView): string {
  return `${problem.kind}:${problem.namespace}/${problem.resourceName}:${problem.resourceKind}`;
}

function affected(problem: ProblemView): ProblemNode["affectedResources"][number] {
  return {
    namespace: problem.namespace,
    resourceKind: problem.resourceKind as SandboxResourceKind,
    resourceName: problem.resourceName,
  };
}

function pickParent(child: ProblemView, problems: ProblemView[]): ProblemView | undefined {
  for (const rule of RULES) {
    if (rule.childKind !== child.kind) continue;
    const candidate = problems.find(
      (parent) => parent.kind === rule.parentKind && (rule.match ? rule.match(child, parent) : true),
    );
    if (candidate) return candidate;
  }
  return undefined;
}

/** Group problems by `kind` and produce a DAG where each node represents a
 *  problem class for a single namespace (the granularity operators care about).
 *  Identical kinds in the same namespace are merged into a single node whose
 *  `affectedResources[]` lists the affected names. */
export function buildProblemDag(problems: ProblemView[]): ProblemDag {
  type Aggregate = {
    node: ProblemNode;
    members: ProblemView[];
  };

  const aggregateKey = (problem: ProblemView): string => `${problem.kind}:${problem.namespace}`;
  const aggregates = new Map<string, Aggregate>();

  for (const problem of problems) {
    const key = aggregateKey(problem);
    const existing = aggregates.get(key);
    if (existing) {
      existing.node.affectedResources.push(affected(problem));
      existing.members.push(problem);
      continue;
    }
    aggregates.set(key, {
      node: {
        id: key,
        kind: problem.kind,
        severity: problem.severity,
        summary: problem.summary,
        affectedResources: [affected(problem)],
      },
      members: [problem],
    });
  }

  // Resolve parent links by looking at any member of each aggregate.
  for (const aggregate of aggregates.values()) {
    const sample = aggregate.members[0];
    if (!sample) continue;
    const parent = pickParent(sample, problems);
    if (parent) {
      const parentKey = aggregateKey(parent);
      if (parentKey !== aggregate.node.id && aggregates.has(parentKey)) {
        aggregate.node.parentId = parentKey;
      }
    }
  }

  // Break any accidental cycles defensively (rules above are acyclic by design).
  for (const aggregate of aggregates.values()) {
    const visited = new Set<string>();
    let cursor: string | undefined = aggregate.node.parentId;
    while (cursor) {
      if (visited.has(cursor) || cursor === aggregate.node.id) {
        delete aggregate.node.parentId;
        break;
      }
      visited.add(cursor);
      cursor = aggregates.get(cursor)?.node.parentId;
    }
  }

  const byId: Record<string, ProblemNode> = {};
  const roots: string[] = [];
  for (const aggregate of aggregates.values()) {
    byId[aggregate.node.id] = aggregate.node;
    if (!aggregate.node.parentId) {
      roots.push(aggregate.node.id);
    }
  }

  // Stable root order: errors first, then warnings, then info, ties by count desc.
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  roots.sort((leftId, rightId) => {
    const left = byId[leftId]!;
    const right = byId[rightId]!;
    const severityDelta = severityRank[left.severity] - severityRank[right.severity];
    if (severityDelta !== 0) return severityDelta;
    return right.affectedResources.length - left.affectedResources.length;
  });

  return { roots, byId };
}

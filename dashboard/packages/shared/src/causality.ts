import type {
  ProblemDag,
  ProblemId,
  ProblemKind,
  ProblemNode,
  ProblemView,
  SandboxResourceKind,
} from "./types.js";

function asProblemId(value: string): ProblemId {
  return value as ProblemId;
}

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

/** Mutates `nodes` in place: clears any `parentId` chain that loops back on
 *  itself. Exported for tests; callers should prefer {@link buildProblemDag}. */
export function breakParentCycles(nodes: Map<ProblemId, ProblemNode>): void {
  for (const node of nodes.values()) {
    const visited = new Set<ProblemId>();
    let cursor: ProblemId | undefined = node.parentId;
    while (cursor) {
      if (visited.has(cursor) || cursor === node.id) {
        delete node.parentId;
        break;
      }
      visited.add(cursor);
      cursor = nodes.get(cursor)?.parentId;
    }
  }
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

/** Aggregate problems by (kind, namespace) into a DAG of cause-effect nodes. */
export function buildProblemDag(problems: ProblemView[]): ProblemDag {
  type Aggregate = {
    node: ProblemNode;
    members: ProblemView[];
  };

  const aggregateKey = (problem: ProblemView): ProblemId => asProblemId(`${problem.kind}:${problem.namespace}`);
  const aggregates = new Map<ProblemId, Aggregate>();

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

  // Defensive cycle-break: the rules above are acyclic by design, but a
  // future rule addition could introduce a loop. Strip any parentId whose
  // chain reaches the node itself rather than rendering an infinite tree.
  breakParentCycles(new Map(Array.from(aggregates, ([id, aggregate]) => [id, aggregate.node])));

  const byId = {} as Record<ProblemId, ProblemNode>;
  const roots: ProblemId[] = [];
  for (const aggregate of aggregates.values()) {
    byId[aggregate.node.id] = aggregate.node;
    if (!aggregate.node.parentId) {
      roots.push(aggregate.node.id);
    }
  }

  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  roots.sort((leftId, rightId) => {
    const left = byId[leftId];
    const right = byId[rightId];
    if (!left || !right) return 0;
    const severityDelta = severityRank[left.severity] - severityRank[right.severity];
    if (severityDelta !== 0) return severityDelta;
    return right.affectedResources.length - left.affectedResources.length;
  });

  return { roots, byId };
}

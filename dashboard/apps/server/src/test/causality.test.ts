import { describe, expect, it } from "vitest";
import { buildProblemDag, type ProblemId, type ProblemView } from "@agent-sandbox/dashboard-shared";

function id(value: string): ProblemId {
  return value as ProblemId;
}

function problem(kind: ProblemView["kind"], namespace = "demo", name = "x"): ProblemView {
  return {
    kind,
    severity: "warning",
    namespace,
    resourceKind: "Sandbox",
    resourceName: name,
    summary: kind,
  };
}

describe("buildProblemDag", () => {
  it("returns empty dag for no problems", () => {
    const dag = buildProblemDag([]);
    expect(dag.roots).toHaveLength(0);
    expect(Object.keys(dag.byId)).toHaveLength(0);
  });

  it("links runtime-missing under unresolved-template-link when both in same namespace", () => {
    const dag = buildProblemDag([
      problem("unresolved-template-link", "demo", "claim-1"),
      problem("runtime-missing", "demo", "sandbox-1"),
    ]);
    expect(dag.roots).toEqual(["unresolved-template-link:demo"]);
    expect(dag.byId[id("runtime-missing:demo")]?.parentId).toBe("unresolved-template-link:demo");
  });

  it("keeps unrelated problems as separate roots", () => {
    const dag = buildProblemDag([
      problem("warm-pool-underfilled", "team-a"),
      problem("runtime-missing", "team-b"),
    ]);
    expect(dag.roots.sort()).toEqual([
      "runtime-missing:team-b",
      "warm-pool-underfilled:team-a",
    ]);
  });

  it("aggregates multiple problems of the same kind in the same namespace", () => {
    const dag = buildProblemDag([
      problem("runtime-missing", "demo", "sb-1"),
      problem("runtime-missing", "demo", "sb-2"),
    ]);
    expect(dag.roots).toEqual(["runtime-missing:demo"]);
    expect(dag.byId[id("runtime-missing:demo")]!.affectedResources).toHaveLength(2);
  });

  it("does not produce cycles", () => {
    const dag = buildProblemDag([
      problem("warm-pool-underfilled", "demo"),
      problem("claim-stuck-pending", "demo"),
      problem("unresolved-template-link", "demo"),
    ]);
    for (const node of Object.values(dag.byId)) {
      const visited = new Set<string>();
      let cursor = node.parentId;
      while (cursor) {
        expect(visited.has(cursor)).toBe(false);
        visited.add(cursor);
        cursor = dag.byId[cursor]?.parentId;
      }
    }
  });
});

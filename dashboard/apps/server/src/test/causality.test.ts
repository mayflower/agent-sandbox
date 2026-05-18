import { describe, expect, it } from "vitest";
import {
  breakParentCycles,
  buildProblemDag,
  type ProblemId,
  type ProblemNode,
  type ProblemView,
} from "@agent-sandbox/dashboard-shared";

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

describe("breakParentCycles", () => {
  function node(rawId: string, parentId?: string): ProblemNode {
    const base: ProblemNode = {
      id: rawId as ProblemId,
      kind: "runtime-missing",
      severity: "warning",
      summary: rawId,
      affectedResources: [],
    };
    if (parentId !== undefined) base.parentId = parentId as ProblemId;
    return base;
  }

  it("clears parentId when a node points to itself", () => {
    const self = node("self", "self");
    const map = new Map<ProblemId, ProblemNode>([[self.id, self]]);
    breakParentCycles(map);
    expect(self.parentId).toBeUndefined();
  });

  it("breaks 3-node parent cycles by clearing at least one pointer", () => {
    // a -> b -> c -> a. The algorithm only needs to clear one parentId to
    // make the graph acyclic; clearing all three would over-correct and
    // discard valid cause/effect information once the loop is broken.
    const a = node("a", "b");
    const b = node("b", "c");
    const c = node("c", "a");
    const map = new Map<ProblemId, ProblemNode>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    breakParentCycles(map);
    const remaining = [a, b, c].filter((n) => n.parentId !== undefined);
    expect(remaining.length).toBeLessThan(3);
    for (const start of [a, b, c]) {
      const visited = new Set<ProblemId>();
      let cursor = start.parentId;
      while (cursor) {
        expect(visited.has(cursor)).toBe(false);
        expect(cursor).not.toBe(start.id);
        visited.add(cursor);
        cursor = map.get(cursor)?.parentId;
      }
    }
  });

  it("preserves valid parent chains that don't loop", () => {
    // root <- middle <- leaf  — a regular tree, no cycle.
    const root = node("root");
    const middle = node("middle", "root");
    const leaf = node("leaf", "middle");
    const map = new Map<ProblemId, ProblemNode>([
      [root.id, root],
      [middle.id, middle],
      [leaf.id, leaf],
    ]);
    breakParentCycles(map);
    expect(root.parentId).toBeUndefined();
    expect(middle.parentId).toBe("root");
    expect(leaf.parentId).toBe("middle");
  });
});

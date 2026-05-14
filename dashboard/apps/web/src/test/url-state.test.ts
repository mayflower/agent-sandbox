import { describe, expect, it } from "vitest";
import { parseUrlState, serializeUrlState, type UrlState } from "../lib/url-state";

describe("url-state", () => {
  it("round-trips an empty state", () => {
    const empty = parseUrlState("");
    expect(serializeUrlState(empty)).toBe("");
  });

  it("serializes and parses every supported field", () => {
    const state: UrlState = {
      view: "tenant",
      tab: "claims",
      namespace: "team-a",
      search: "vite",
      brokenOnly: true,
      scrubAt: "2026-04-15T10:00:00.000Z",
      expandedProblems: ["runtime-missing", "warm-pool-underfilled"],
      drawer: { resourceKind: "Sandbox", namespace: "team-a", resourceName: "foo-bar" },
      story: { namespace: "team-a", name: "foo-bar" },
    };
    const query = serializeUrlState(state);
    const parsed = parseUrlState(query);
    expect(parsed).toEqual(state);
  });

  it("falls back to operator when view is unknown", () => {
    const parsed = parseUrlState("?view=garbage");
    expect(parsed.view).toBe("operator");
  });

  it("parses drawer for each resource kind", () => {
    for (const [tag, kind] of [
      ["sandbox", "Sandbox"],
      ["claim", "SandboxClaim"],
      ["warm-pool", "SandboxWarmPool"],
      ["template", "SandboxTemplate"],
    ] as const) {
      const parsed = parseUrlState(`?drawer=${tag}:demo/x`);
      expect(parsed.drawer?.resourceKind).toBe(kind);
    }
  });
});

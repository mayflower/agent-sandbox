import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { CauseTree } from "../components/CauseTree";
import { FilterProvider } from "../lib/filters";
import { NowProvider } from "../lib/now";
import type { ProblemDag, ProblemId } from "@agent-sandbox/dashboard-shared";

function id(value: string): ProblemId {
  return value as ProblemId;
}

function dagFixture(): ProblemDag {
  return {
    roots: [id("unresolved-template-link:demo")],
    byId: {
      [id("unresolved-template-link:demo")]: {
        id: id("unresolved-template-link:demo"),
        kind: "unresolved-template-link",
        severity: "warning",
        summary: "Template missing",
        affectedResources: [{ namespace: "demo", resourceKind: "Sandbox", resourceName: "sb-1" }],
      },
      [id("runtime-missing:demo")]: {
        id: id("runtime-missing:demo"),
        kind: "runtime-missing",
        severity: "error",
        summary: "Runtime missing",
        parentId: id("unresolved-template-link:demo"),
        affectedResources: [{ namespace: "demo", resourceKind: "Sandbox", resourceName: "sb-1" }],
      },
    } as ProblemDag["byId"],
  };
}

function wrap(children: React.ReactNode) {
  return (
    <NowProvider>
      <FilterProvider>{children}</FilterProvider>
    </NowProvider>
  );
}

describe("CauseTree", () => {
  it("renders the root summary", () => {
    render(wrap(<CauseTree dag={dagFixture()} />));
    expect(screen.getByText("Template missing")).toBeInTheDocument();
  });

  it("hides ack'd roots from the tree", () => {
    render(wrap(<CauseTree dag={dagFixture()} acks={new Set(["unresolved-template-link"])} />));
    expect(screen.queryByText("Template missing")).toBeNull();
  });

  it("shows empty-state when there are no roots", () => {
    render(wrap(<CauseTree dag={{ roots: [], byId: {} as ProblemDag["byId"] }} />));
    expect(screen.getByText(/No problems detected/i)).toBeInTheDocument();
  });

  it("invokes onAck with the first row in severity order when its button is clicked", () => {
    let acked = "";
    render(
      wrap(
        <CauseTree
          dag={dagFixture()}
          onAck={(kind) => {
            acked = kind;
          }}
        />,
      ),
    );
    // Flat list sorts by severity (error < warning < info). The fixture has
    // one error ("runtime-missing") and one warning, so the first row is
    // unambiguously runtime-missing — any sort-order regression would fail.
    const buttons = screen.getAllByText("ack 1h");
    fireEvent.click(buttons[0]!);
    expect(acked).toBe("runtime-missing");
  });
});

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Sparkline } from "../components/Sparkline";

describe("Sparkline", () => {
  it("renders an em dash for empty input", () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.textContent).toContain("—");
  });

  it("emits an svg path for non-empty values", () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4, 5]} />);
    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    expect(path?.getAttribute("d")?.length).toBeGreaterThan(0);
  });
});

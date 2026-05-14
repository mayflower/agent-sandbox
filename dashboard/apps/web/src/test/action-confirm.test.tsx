import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { ActionConfirm } from "../components/ActionConfirm";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ActionConfirm", () => {
  it("fires exactly once after the undo window expires", async () => {
    let fired = 0;
    render(
      <ActionConfirm
        label="extend"
        onConfirm={() => {
          fired += 1;
        }}
        undoWindowMs={1000}
      />,
    );
    fireEvent.click(screen.getByText("extend"));
    expect(screen.getByText(/firing in/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(fired).toBe(1);
  });

  it("undo cancels and prevents the action from firing", async () => {
    let fired = 0;
    render(
      <ActionConfirm
        label="pause"
        onConfirm={() => {
          fired += 1;
        }}
        undoWindowMs={1000}
      />,
    );
    fireEvent.click(screen.getByText("pause"));
    fireEvent.click(screen.getByText("undo"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fired).toBe(0);
  });

  it("irreversible actions fire immediately without arming", async () => {
    let fired = 0;
    render(
      <ActionConfirm
        label="delete"
        irreversible
        onConfirm={() => {
          fired += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByText("delete"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fired).toBe(1);
  });
});

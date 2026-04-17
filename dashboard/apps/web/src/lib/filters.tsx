import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface SandboxTarget {
  namespace: string;
  resourceKind: "Sandbox" | "SandboxClaim" | "SandboxWarmPool" | "SandboxTemplate";
  resourceName: string;
}

interface FilterState {
  search: string;
  namespace: string;
  brokenOnly: boolean;
  target: SandboxTarget | null;
  setSearch: (value: string) => void;
  setNamespace: (value: string) => void;
  toggleBroken: () => void;
  setBrokenOnly: (value: boolean) => void;
  focus: (target: SandboxTarget) => void;
  clearTarget: () => void;
  reset: () => void;
}

const FilterContext = createContext<FilterState | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState("");
  const [namespace, setNamespace] = useState("");
  const [brokenOnly, setBrokenOnly] = useState(false);
  const [target, setTarget] = useState<SandboxTarget | null>(null);

  const toggleBroken = useCallback(() => setBrokenOnly((prev) => !prev), []);
  const focus = useCallback((next: SandboxTarget) => {
    setTarget(next);
    setNamespace(next.namespace);
  }, []);
  const clearTarget = useCallback(() => setTarget(null), []);
  const reset = useCallback(() => {
    setSearch("");
    setNamespace("");
    setBrokenOnly(false);
    setTarget(null);
  }, []);

  const value = useMemo<FilterState>(
    () => ({ search, namespace, brokenOnly, target, setSearch, setNamespace, toggleBroken, setBrokenOnly, focus, clearTarget, reset }),
    [search, namespace, brokenOnly, target, toggleBroken, focus, clearTarget, reset],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterState {
  const ctx = useContext(FilterContext);
  if (!ctx) {
    throw new Error("useFilters must be used within a FilterProvider");
  }
  return ctx;
}

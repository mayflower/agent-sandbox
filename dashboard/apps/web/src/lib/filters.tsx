import type { SandboxResourceKind } from "@agent-sandbox/dashboard-shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  DEFAULT_URL_STATE,
  parseUrlState,
  serializeUrlState,
  type AppView,
  type DrawerTarget,
  type UrlState,
} from "./url-state";

export interface SandboxTarget {
  namespace: string;
  resourceKind: SandboxResourceKind;
  resourceName: string;
}

export interface FilterState {
  search: string;
  namespace: string;
  brokenOnly: boolean;
  /** Resource that triggered an inventory tab switch and a drawer open. */
  target: SandboxTarget | null;
  view: AppView;
  tab: string | undefined;
  scrubAt: string;
  expandedProblems: Set<string>;
  drawer: DrawerTarget | null;
  setSearch(value: string): void;
  setNamespace(value: string): void;
  toggleBroken(): void;
  setBrokenOnly(value: boolean): void;
  setView(value: AppView): void;
  setTab(value: string | undefined): void;
  setScrubAt(value: string): void;
  toggleExpandedProblem(kind: string): void;
  openDrawer(target: DrawerTarget): void;
  closeDrawer(): void;
  focus(target: SandboxTarget): void;
  clearTarget(): void;
  reset(): void;
}

const FilterContext = createContext<FilterState | null>(null);

function asDrawerKind(kind: SandboxResourceKind): DrawerTarget["resourceKind"] {
  return kind;
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const initial = useRef<UrlState>(parseUrlState());
  const initialState = initial.current;

  const [search, setSearch] = useState(initialState.search);
  const [namespace, setNamespace] = useState(initialState.namespace);
  const [brokenOnly, setBrokenOnly] = useState(initialState.brokenOnly);
  const [target, setTarget] = useState<SandboxTarget | null>(null);
  const [view, setView] = useState<AppView>(initialState.view);
  const [tab, setTab] = useState<string | undefined>(initialState.tab);
  const [scrubAt, setScrubAt] = useState(initialState.scrubAt);
  const [expandedProblems, setExpandedProblems] = useState<Set<string>>(
    () => new Set(initialState.expandedProblems),
  );
  const [drawer, setDrawer] = useState<DrawerTarget | null>(initialState.drawer ?? null);

  const toggleBroken = useCallback(() => setBrokenOnly((prev) => !prev), []);

  const focus = useCallback((next: SandboxTarget) => {
    setTarget(next);
    setNamespace(next.namespace);
    setDrawer({
      resourceKind: asDrawerKind(next.resourceKind),
      namespace: next.namespace,
      resourceName: next.resourceName,
    });
  }, []);

  const clearTarget = useCallback(() => setTarget(null), []);

  const openDrawer = useCallback((next: DrawerTarget) => {
    setDrawer(next);
  }, []);

  const closeDrawer = useCallback(() => setDrawer(null), []);

  const toggleExpandedProblem = useCallback((kind: string) => {
    setExpandedProblems((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSearch("");
    setNamespace("");
    setBrokenOnly(false);
    setTarget(null);
    setScrubAt("");
    setExpandedProblems(new Set());
    setDrawer(null);
  }, []);

  // Push state changes to the URL. React batches state updates within an
  // event handler, so this effect fires once per commit even when multiple
  // setters are called.
  useEffect(() => {
    const state: UrlState = {
      view,
      namespace,
      search,
      brokenOnly,
      scrubAt,
      expandedProblems: [...expandedProblems],
      ...(tab !== undefined ? { tab } : {}),
      ...(drawer ? { drawer } : {}),
    };
    const query = serializeUrlState(state);
    if (window.location.search !== query) {
      window.history.replaceState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
    }
  }, [view, namespace, search, brokenOnly, scrubAt, expandedProblems, tab, drawer]);

  // Listen to popstate (browser back/forward) and hydrate state from URL.
  useEffect(() => {
    function onPop() {
      const next = parseUrlState();
      setView(next.view);
      setSearch(next.search);
      setNamespace(next.namespace);
      setBrokenOnly(next.brokenOnly);
      setScrubAt(next.scrubAt);
      setExpandedProblems(new Set(next.expandedProblems));
      setTab(next.tab);
      setDrawer(next.drawer ?? null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const value = useMemo<FilterState>(
    () => ({
      search,
      namespace,
      brokenOnly,
      target,
      view,
      tab,
      scrubAt,
      expandedProblems,
      drawer,
      setSearch,
      setNamespace,
      toggleBroken,
      setBrokenOnly,
      setView,
      setTab,
      setScrubAt,
      toggleExpandedProblem,
      openDrawer,
      closeDrawer,
      focus,
      clearTarget,
      reset,
    }),
    [
      search,
      namespace,
      brokenOnly,
      target,
      view,
      tab,
      scrubAt,
      expandedProblems,
      drawer,
      toggleBroken,
      toggleExpandedProblem,
      openDrawer,
      closeDrawer,
      focus,
      clearTarget,
      reset,
    ],
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

/** Test-only re-export of DEFAULT_URL_STATE. */
export const __INTERNAL = { DEFAULT_URL_STATE };

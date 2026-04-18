import { useCallback, useState } from "react";

export interface Expandable {
  has: (key: string) => boolean;
  toggle: (key: string) => void;
}

export function useExpandable(initial?: Iterable<string>): Expandable {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial));
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return {
    has: (key) => expanded.has(key),
    toggle,
  };
}

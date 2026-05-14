import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** A single 1 Hz clock shared across all consumers so N countdown badges and
 *  StatusBar's "updated Xs ago" don't each spawn their own setInterval. */
const NowContext = createContext<number>(Date.now());

export function NowProvider({ children }: { children: ReactNode }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <NowContext.Provider value={nowMs}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}

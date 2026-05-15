import type { UrlState } from "./url-state";

export interface SavedView {
  id: string;
  name: string;
  state: UrlState;
}

// Namespace by origin so two tabs pointing at different backends don't collide.
const ORIGIN_SUFFIX = typeof window !== "undefined" ? `:${window.location.origin}` : "";
const STORAGE_KEY = `agent-sandbox-dashboard.saved-views${ORIGIN_SUFFIX}`;
const ACK_KEY = `agent-sandbox-dashboard.problem-acks${ORIGIN_SUFFIX}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    // Quota exceeded or storage unavailable. Return false so callers can
    // surface a toast; UI continues to function in either case.
    // eslint-disable-next-line no-console
    console.warn(`[saved-views] write ${key} failed: ${(error as Error).message}`);
    return false;
  }
}

export function listSavedViews(): SavedView[] {
  return readJson<SavedView[]>(STORAGE_KEY, []);
}

export function saveView(view: SavedView): SavedView[] {
  const existing = listSavedViews().filter((entry) => entry.id !== view.id);
  const next = [...existing, view];
  writeJson(STORAGE_KEY, next);
  return next;
}

export function deleteSavedView(id: string): SavedView[] {
  const next = listSavedViews().filter((entry) => entry.id !== id);
  writeJson(STORAGE_KEY, next);
  return next;
}

export interface ProblemAck {
  kind: string;
  reason?: string;
  expiresAt: number;
}

export function listAcks(): ProblemAck[] {
  const all = readJson<ProblemAck[]>(ACK_KEY, []);
  const now = Date.now();
  return all.filter((ack) => ack.expiresAt > now);
}

export function ackProblem(kind: string, reason?: string, durationMs = 60 * 60_000): ProblemAck[] {
  const filtered = listAcks().filter((ack) => ack.kind !== kind);
  const ack: ProblemAck = { kind, expiresAt: Date.now() + durationMs };
  if (reason) ack.reason = reason;
  const next = [...filtered, ack];
  writeJson(ACK_KEY, next);
  return next;
}

export function clearAck(kind: string): ProblemAck[] {
  const next = listAcks().filter((ack) => ack.kind !== kind);
  writeJson(ACK_KEY, next);
  return next;
}

export const DENSITY_KEY = `agent-sandbox-dashboard.density${ORIGIN_SUFFIX}`;
export type Density = "compact" | "comfortable" | "card";

export function loadDensity(): Density {
  const value = window.localStorage.getItem(DENSITY_KEY);
  return value === "compact" || value === "comfortable" || value === "card" ? value : "comfortable";
}

export function saveDensity(value: Density): boolean {
  try {
    window.localStorage.setItem(DENSITY_KEY, value);
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[saved-views] density write failed: ${(error as Error).message}`);
    return false;
  }
}

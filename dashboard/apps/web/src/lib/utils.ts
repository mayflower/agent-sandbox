import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatAge(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function matchesSearch(name: string, namespace: string, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return name.toLowerCase().includes(needle) || namespace.toLowerCase().includes(needle);
}

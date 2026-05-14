import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";

export function CountdownBadge({ until }: { until: string | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!until) return <Badge tone="neutral">no shutdown</Badge>;
  const target = Date.parse(until);
  if (Number.isNaN(target)) return <Badge tone="neutral">unknown</Badge>;
  const delta = Math.max(0, target - now);
  if (delta === 0) return <Badge tone="danger">expired</Badge>;
  const seconds = Math.floor(delta / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  let label: string;
  if (hours > 0) label = `${hours}h ${minutes}m`;
  else if (minutes > 0) label = `${minutes}m ${remaining}s`;
  else label = `${remaining}s`;
  return <Badge tone={hours < 1 ? "warning" : "info"}>{label}</Badge>;
}

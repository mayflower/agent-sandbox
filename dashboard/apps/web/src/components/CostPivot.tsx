import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

const GROUP_OPTIONS = [
  { value: "template", label: "Template" },
  { value: "namespace", label: "Namespace" },
  { value: "label:agents.x-k8s.io/tenant", label: "Tenant label" },
];

export function CostPivot() {
  const [groupBy, setGroupBy] = useState<string>("template");
  const query = useQuery({
    queryKey: ["cost-by-dimension", groupBy],
    queryFn: () => api.costByDimension(groupBy),
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">Cost by {groupBy.replace("label:", "")}</CardTitle>
        <Select value={groupBy} onValueChange={setGroupBy}>
          <SelectTrigger className="h-7 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUP_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {!query.data || query.data.rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {query.data === null ? "Cost view requires config/cost.yaml." : "No data."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead className="text-right">$/h</TableHead>
                <TableHead className="text-right">Idle $/h</TableHead>
                <TableHead className="text-right">Instances</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.rows.map((row) => (
                <TableRow key={row.group}>
                  <TableCell className="font-mono text-xs">{row.group}</TableCell>
                  <TableCell className="text-right tabular-nums">${row.usdPerHour.toFixed(2)}</TableCell>
                  <TableCell className="text-right tabular-nums text-amber-600">
                    {row.idleUsdPerHour > 0 ? `$${row.idleUsdPerHour.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.instanceCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

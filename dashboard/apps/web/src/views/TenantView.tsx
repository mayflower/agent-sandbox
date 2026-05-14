import type { ClaimLiveView, Identity, SandboxLiveView } from "@agent-sandbox/dashboard-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { ActionConfirm } from "@/components/ActionConfirm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CountdownBadge } from "@/components/CountdownBadge";
import { QuotaPanel } from "@/components/QuotaPanel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

export function TenantView({ identity }: { identity: Identity }) {
  const sandboxes = useQuery({ queryKey: ["sandboxes"], queryFn: api.sandboxes, refetchInterval: 5000 });
  const claims = useQuery({ queryKey: ["claims"], queryFn: api.claims, refetchInterval: 5000 });

  const myNamespaces = useMemo(() => {
    if (identity.role === "operator") return [];
    return identity.namespaces;
  }, [identity]);

  const inScope = (item: { namespace: string }) =>
    myNamespaces.length === 0 || myNamespaces.includes(item.namespace);
  const myClaims = (claims.data ?? []).filter(inScope);
  const mySandboxes = (sandboxes.data ?? []).filter(inScope);

  return (
    <div className="space-y-3 p-4 md:p-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Tenant view <Badge tone="info">{identity.user}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Showing only resources in {myNamespaces.length > 0 ? myNamespaces.join(", ") : "all namespaces (operator)"}.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-[1fr_minmax(0,18rem)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Your claims</CardTitle>
          </CardHeader>
          <CardContent>
            <ClaimTable claims={myClaims} />
          </CardContent>
        </Card>

        <div className="space-y-3">
          <QuotaPanel namespaces={myNamespaces} sandboxes={mySandboxes} claims={myClaims} />
        </div>
      </div>
    </div>
  );
}

function ClaimTable({ claims }: { claims: ClaimLiveView[] }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries();

  const extend = useMutation({
    mutationFn: ({ namespace, name, seconds }: { namespace: string; name: string; seconds: number }) =>
      api.extendClaim(namespace, name, seconds),
    onSuccess: invalidate,
  });
  const pause = useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) => api.pauseSandbox(namespace, name),
    onSuccess: invalidate,
  });
  const resume = useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) => api.resumeSandbox(namespace, name),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) => api.deleteClaim(namespace, name),
    onSuccess: invalidate,
  });

  if (claims.length === 0) {
    return <p className="text-xs text-muted-foreground">No claims in scope.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Namespace</TableHead>
          <TableHead>Claim</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Shutdown</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {claims.map((claim) => (
          <TableRow key={`${claim.namespace}/${claim.name}`}>
            <TableCell className="font-mono text-xs">{claim.namespace}</TableCell>
            <TableCell className="font-mono text-xs">{claim.name}</TableCell>
            <TableCell>
              <Badge tone={claim.effectiveReady ? "success" : claim.state === "pending" ? "warning" : "neutral"}>
                {claim.state}
              </Badge>
            </TableCell>
            <TableCell><CountdownBadge until={claim.shutdownTime} /></TableCell>
            <TableCell className="space-x-1 text-right">
              <ActionConfirm
                label="extend 30m"
                onConfirm={async () => {
                  await extend.mutateAsync({ namespace: claim.namespace, name: claim.name, seconds: 1800 });
                }}
              />
              <ActionConfirm
                label={claim.effectiveReady ? "pause" : "resume"}
                onConfirm={async () => {
                  if (!claim.sandboxName) return;
                  if (claim.effectiveReady) {
                    await pause.mutateAsync({ namespace: claim.namespace, name: claim.sandboxName });
                  } else {
                    await resume.mutateAsync({ namespace: claim.namespace, name: claim.sandboxName });
                  }
                }}
                disabled={!claim.sandboxName}
              />
              <ActionConfirm
                label="delete"
                tone="danger"
                irreversible
                onConfirm={async () => {
                  await remove.mutateAsync({ namespace: claim.namespace, name: claim.name });
                }}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

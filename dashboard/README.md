# Agent Sandbox Dashboard

Optional read-only live dashboard for the `agent-sandbox` repository.

## Scope

- live snapshot only
- no Prometheus
- no history storage
- no write actions against Kubernetes
- capability-driven support for extension resources

## Workspace

```bash
cd dashboard
npm ci
npm run build
npm run test:ci
```

The root `make test-unit` target expects this workspace to be bootstrapped already. It runs `npm run test:ci`, but it does not install dashboard dependencies on your behalf.

## Packages

- `apps/web`: React dashboard UI
- `apps/server`: Fastify BFF and Kubernetes adapter
- `packages/shared`: contracts, fixtures, normalizers, aggregators

## Development

Use the fake provider to iterate without a cluster:

```bash
cd dashboard/apps/server
DASHBOARD_FAKE_PROVIDER=true npm run dev
```

The production image is built from [`dashboard/Dockerfile`](./Dockerfile) and the optional Kubernetes deployment lives in [`k8s/dashboard.yaml`](../k8s/dashboard.yaml). Repo tooling keeps that manifest opt-in only:

- `./dev/tools/deploy-to-kube --dashboard` applies it
- `make deploy-kind DASHBOARD=true` includes it in local kind deploys
- `./dev/tools/release --tag=vX.Y.Z` publishes it as a separate `dashboard.yaml` release asset

# Dashboard Guide

The optional dashboard provides a live, read-only view of `agent-sandbox` resources in a cluster. It is intentionally scoped to current state only.

## Constraints

- no write actions against Kubernetes
- no history storage
- no Prometheus dependency
- no database
- backend-for-frontend only; the browser does not talk to Kubernetes directly

## Workspace Layout

- `dashboard/apps/web`: React and Vite frontend
- `dashboard/apps/server`: Fastify API and static asset server
- `dashboard/packages/shared`: shared contracts, fixtures, normalizers, and overview aggregation

## Local Development

Install dependencies and run the workspace checks:

```sh
cd dashboard
npm ci
npm run build
npm run test:ci
```

For local API and UI work without a cluster, start the server with fixture-backed data:

```sh
cd dashboard/apps/server
DASHBOARD_FAKE_PROVIDER=true npm run dev
```

## Deployment

The dashboard uses a dedicated image and a separate Kubernetes manifest:

- image build: [`dashboard/Dockerfile`](../dashboard/Dockerfile)
- manifest: [`k8s/dashboard.yaml`](../k8s/dashboard.yaml)

This manifest is opt-in. It is excluded from the default deploy scan so that the main controller deployment behavior stays unchanged.

Use one of these paths when you want the dashboard:

```sh
make deploy-kind DASHBOARD=true
./dev/tools/deploy-to-kube --image-prefix=<registry-url-with-trailing-slash> --dashboard
```

## Release Artifacts

Release generation keeps the dashboard separate from the core and extension bundles:

- `manifest.yaml`: core controller and CRDs
- `extensions.yaml`: extension resources
- `dashboard.yaml`: optional dashboard deployment

If `k8s/dashboard.yaml` is present, `./dev/tools/release --tag=vX.Y.Z` emits `release_assets/dashboard.yaml`, and `dev/tools/tag-promote-images` can promote the `dashboard` image alongside the controller image.

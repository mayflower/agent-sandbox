# E2E testing

This guide provides instructions for running e2e tests.

## Prerequisites

See the [development guide](../../docs/development.md) for prerequisite tools
and for instructions on how to build/deploy agent-sandbox.

## Running the e2e tests

The e2e tests assume that the cluster is created and that the kubeconfig for the
cluster lives in `bin/KUBECONFIG`. This can be used to connect the e2e tests to
an arbitrary cluster, but for the sake of this guide we will use a
[kind cluster](https://github.com/kubernetes-sigs/kind).

First create a kind cluster and install `agent-sandbox`:

```shell
make deploy-kind
```

Next, run the e2e tests on the newly created kind cluster:

```shell
go test ./test/e2e/... --parallel=1
```

Note: the `--parallel=1` argument makes sure only a single test runs at a time.

## sandbox-router is required for client SDK integration tests

All three client SDKs (Python, Go, TypeScript) talk to sandbox pods through a shared HTTP proxy called **sandbox-router** — a Service named `sandbox-router-svc` that routes requests to the correct sandbox pod based on `X-Sandbox-ID` / `X-Sandbox-Namespace` / `X-Sandbox-Port` headers. The SDKs' `direct`, `gateway`, and `tunnel` connection modes all target this router rather than the sandbox pods directly.

`make deploy-kind` installs the controller and CRDs but **does not currently deploy sandbox-router**. Before running any SDK integration test that needs a sandbox connection (the Python `langchain-agent-sandbox` e2e, the TypeScript `vitest --mode int` suite, or a local Go SDK smoke test against the `tunnel` strategy), build the router image and deploy it into the target namespace. The manifest at `clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml` contains a literal `image: IMAGE_PLACEHOLDER` line that must be substituted before `kubectl apply`, so `kubectl apply -f sandbox_router.yaml` directly will produce a CrashLoopBackOff.

```shell
# Build and make the router image available to the cluster
export SANDBOX_ROUTER_IMG=your_registry/sandbox-router:latest
docker build -t "$SANDBOX_ROUTER_IMG" clients/python/agentic-sandbox-client/sandbox-router/
# For kind, load the image instead of pushing to a registry:
kind load docker-image "$SANDBOX_ROUTER_IMG" --name agent-sandbox

# Substitute the placeholder and apply (no in-place sed)
sed "s|IMAGE_PLACEHOLDER|${SANDBOX_ROUTER_IMG}|g" \
  clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml \
  | kubectl --kubeconfig bin/KUBECONFIG apply -n <namespace> -f -
```

The full build + deploy guide (including configuration env vars and the optional Gateway mode) lives at [`clients/python/agentic-sandbox-client/sandbox-router/README.md`](../../clients/python/agentic-sandbox-client/sandbox-router/README.md). The manifest lives under the Python SDK directory for historical reasons but is the one canonical router Deployment the entire project uses.

## langchain-agent-sandbox (TypeScript) integration tests

The TypeScript backend at [`clients/typescript/langchain-agent-sandbox`](../../clients/typescript/langchain-agent-sandbox) ships two integration test suites that share the same `pnpm test:int` entry point and the same kind-cluster wiring through `dev/tools/test-e2e`:

- `src/sandbox.int.test.ts` — exercises the `K8sAgentSandbox` provider directly via `sandboxStandardTests`. Backend-only; no LLM.
- `src/agent.int.test.ts` — runs an actual `createDeepAgent` (deepagents-js) loop against the same backend with a real LLM and asserts a deterministic file-write side effect. Requires `ANTHROPIC_API_KEY` in addition to the cluster env vars below; skips cleanly without one.

Both suites are **gated by environment variables** so they skip silently when unconfigured or when `pnpm` is not available on `PATH`.

End-to-end local workflow against a kind cluster:

```shell
# 1. Bring up the cluster + controller (kubeconfig at bin/KUBECONFIG)
make deploy-kind

# 2. Build and deploy sandbox-router into the target namespace
#    (see the "sandbox-router is required" section above for details).
export SANDBOX_ROUTER_IMG=kind.local/sandbox-router:latest
docker build -t "$SANDBOX_ROUTER_IMG" clients/python/agentic-sandbox-client/sandbox-router/
kind load docker-image "$SANDBOX_ROUTER_IMG" --name agent-sandbox
sed "s|IMAGE_PLACEHOLDER|${SANDBOX_ROUTER_IMG}|g" \
  clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml \
  | kubectl --kubeconfig bin/KUBECONFIG apply -f -

# 3. Apply a SandboxTemplate the test can claim from
kubectl --kubeconfig bin/KUBECONFIG apply -f examples/langchain-deepagentsjs/sandbox-template.yaml

# 4. Run the full e2e suite (Go + Python + TypeScript)
LANGCHAIN_SANDBOX_TEMPLATE=python-deepagent make test-e2e

# Or run just the TypeScript int suite directly:
cd clients/typescript/langchain-agent-sandbox
LANGCHAIN_SANDBOX_TEMPLATE=python-deepagent \
  KUBECONFIG=$(git rev-parse --show-toplevel)/bin/KUBECONFIG \
  pnpm test:int
```

Recognized environment variables:

- `LANGCHAIN_SANDBOX_TEMPLATE` (required) — name of the `SandboxTemplate` resource the test should provision sandboxes from
- `LANGCHAIN_NAMESPACE` (optional, default: `default`) — namespace to create the `SandboxClaim` in; must contain a `sandbox-router-svc` Service
- `KUBECONFIG` (optional, defaults to `~/.kube/config`) — `make test-e2e` sets this to `bin/KUBECONFIG` automatically
- `ANTHROPIC_API_KEY` (required ONLY for `agent.int.test.ts`) — the agent loop test makes a small number of LLM calls per run; without this var the agent suite skips and the rest of the int suite still runs
- `LANGCHAIN_SANDBOX_AGENT_MODEL` (optional, default: `claude-sonnet-4-5-20250929`) — override the model the agent test uses
- The legacy names `SANDBOX_TEMPLATE` / `SANDBOX_NAMESPACE` are still accepted as fallbacks

When the TS package or `pnpm` is not present, `dev/tools/test-e2e` prints a warning and continues with the Go and Python suites — TypeScript test failure does not block the rest of the e2e run. When the sandbox-router service is missing from the target namespace, the TS tunnel strategy will time out after 30 seconds with a `CONNECTION_FAILED` error; deploy the router (see section above) and re-run.

# langchain-agent-sandbox

Kubernetes [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) backend for [deepagents-js](https://github.com/langchain-ai/deepagentsjs).

This package provides a `SandboxBackendProtocol` implementation that connects to sandbox pods managed by the `agent-sandbox` controller. Agents get isolated Kubernetes pods with command execution and file operations, mirroring the Python [`langchain-agent-sandbox`](../../python/langchain-agent-sandbox) package.

## Installation

```bash
pnpm add langchain-agent-sandbox deepagents
# or: npm install langchain-agent-sandbox deepagents
```

## Quick Start

### Connect to an existing sandbox

```typescript
import { K8sAgentSandbox } from "langchain-agent-sandbox";

const sandbox = K8sAgentSandbox.fromUrl(
  "http://localhost:8080", // sandbox-router URL
  "my-sandbox-abc123",     // Sandbox resource name
);
await sandbox.initialize();

const result = await sandbox.execute("python --version");
console.log(result.output);

await sandbox.close();
```

### Create a sandbox from a template

```typescript
const sandbox = await K8sAgentSandbox.create({
  template: "python-sandbox-template",
  namespace: "default",
  deleteOnClose: true,
});

try {
  const result = await sandbox.execute("echo hello");
  console.log(result.output);
} finally {
  await sandbox.close();
}
```

### Use with a deepagent

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { K8sAgentSandbox } from "langchain-agent-sandbox";

const sandbox = await K8sAgentSandbox.create({
  template: "python-sandbox-template",
});

const agent = createDeepAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
  systemPrompt: "You are a coding assistant with sandbox access.",
  backend: sandbox,
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Create a fibonacci function" }],
});

await sandbox.close();
```

## Connection modes

### Direct

Connect to a known sandbox-router URL. Use when you have an existing port-forward, ingress, or load balancer.

```typescript
const sandbox = K8sAgentSandbox.fromUrl("http://localhost:8080", "sandbox-id");
```

### Tunnel (default for `create()`)

Automatically sets up `kubectl port-forward` to the sandbox-router service.

```typescript
const sandbox = await K8sAgentSandbox.create({
  template: "my-template",
  connectionConfig: {
    type: "tunnel",
    namespace: "sandbox-ns",
    portForwardReadyTimeout: 30,
  },
});
```

### Gateway

Discovers the sandbox-router IP from a Kubernetes Gateway resource.

```typescript
const sandbox = await K8sAgentSandbox.create({
  template: "my-template",
  connectionConfig: {
    type: "gateway",
    gatewayName: "sandbox-gateway",
    gatewayNamespace: "infra",
  },
});
```

## API Reference

### `K8sAgentSandbox`

Extends `BaseSandbox` from deepagents. Inherits all file operations (`ls`, `read`, `readRaw`, `write`, `edit`, `grep`, `glob`) which are implemented via shell commands through `execute()`.

#### Static methods

| Method | Description |
|--------|-------------|
| `fromUrl(baseUrl, sandboxId, options?)` | Connect to an existing sandbox via direct URL |
| `create(options)` | Provision a new sandbox via the Kubernetes API |
| `fromExisting(claimName, options?)` | Attach to an existing `SandboxClaim` |
| `deleteAll(labels, namespace?)` | Delete all matching `SandboxClaim`s |

#### Instance methods

| Method | Returns | Description |
|--------|---------|-------------|
| `initialize()` | `Promise<void>` | Connect and verify the sandbox is reachable |
| `execute(command)` | `Promise<ExecuteResponse>` | Run a shell command (wrapped in `sh -c`) |
| `uploadFiles(files)` | `Promise<FileUploadResponse[]>` | Upload files via base64 + `execute()` |
| `downloadFiles(paths)` | `Promise<FileDownloadResponse[]>` | Download files via the sandbox HTTP API |
| `close()` | `Promise<void>` | Close connection, optionally delete sandbox |
| `healthz()` | `Promise<boolean>` | Check whether the sandbox is reachable |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Sandbox resource name |
| `isRunning` | `boolean` | Whether the connection is active |
| `claimName` | `string \| null` | `SandboxClaim` name if provisioned via a claim |
| `namespace` | `string` | Kubernetes namespace |

#### Error handling

`execute()` distinguishes timeouts from other failures:

- `COMMAND_TIMEOUT` — the per-command `defaultTimeout` was exceeded; consider retrying with a longer timeout
- `COMMAND_FAILED` — any other runtime failure (network, process crash, etc.)

Both are thrown as `K8sAgentSandboxError` with a typed `code` field. Inherited file operations (`ls`, `grep`, `glob`, `read`) return result dataclasses (`LsResult`, `GrepResult`, `GlobResult`, `ReadResult`) with `error` fields populated on failure rather than throwing.

## Prerequisites

All three agent-sandbox client SDKs (Python, Go, TypeScript) talk to sandbox pods through a shared HTTP proxy called **sandbox-router**. The router routes requests to the correct pod based on `X-Sandbox-ID` / `X-Sandbox-Namespace` / `X-Sandbox-Port` headers, which lets a single client connection (one port-forward, one ingress, or one gateway IP) address every sandbox in a namespace without tracking individual pod IPs. `langchain-agent-sandbox` inherits this design and **requires the router to be reachable** for any of its three connection modes to work.

**Required in the cluster**

| # | Resource | Notes |
|---|---|---|
| 1 | `agent-sandbox` controller + CRDs | `make deploy-kind` from the repo root, or a hosted install |
| 2 | `sandbox-router` Deployment + Service (named `sandbox-router-svc`) in the target namespace | Manifests: [`clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml`](../../python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml). The same component serves all three SDKs. |
| 3 | A `SandboxTemplate` resource that this package can claim from | See the example at [`examples/langchain-deepagentsjs/sandbox-template.yaml`](../../../examples/langchain-deepagentsjs/sandbox-template.yaml) |

**Required on the client**

- Node 20+ (22 LTS recommended)
- `kubectl` on `PATH` when using `tunnel` mode (direct and gateway modes do not need it)
- A kubeconfig reachable via `$KUBECONFIG` or `~/.kube/config`

> **Note on `make deploy-kind`**
>
> `make deploy-kind` brings up the controller and CRDs but does not currently deploy the sandbox-router. Build the router image, substitute it into the manifest's `image: IMAGE_PLACEHOLDER` line, and apply it to the target namespace before running the example or the integration test suite:
>
> ```bash
> # Build and push (or kind-load) the router image
> export SANDBOX_ROUTER_IMG=your_registry/sandbox-router:latest
> docker build -t "$SANDBOX_ROUTER_IMG" clients/python/agentic-sandbox-client/sandbox-router/
> # For kind, load it into the cluster instead of pushing:
> # kind load docker-image "$SANDBOX_ROUTER_IMG" --name agent-sandbox
>
> # Substitute the placeholder and apply
> sed "s|IMAGE_PLACEHOLDER|${SANDBOX_ROUTER_IMG}|g" \
>   clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml \
>   | kubectl apply -n <namespace> -f -
> ```
>
> The full build + deploy guide lives at [`clients/python/agentic-sandbox-client/sandbox-router/README.md`](../../python/agentic-sandbox-client/sandbox-router/README.md). This is the same manual step the Python SDK's integration tests rely on.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test           # unit tests (mocked, no cluster needed)
pnpm test:int       # integration tests (requires a kind cluster, sandbox-router, and LANGCHAIN_SANDBOX_TEMPLATE)
```

## License

Apache-2.0

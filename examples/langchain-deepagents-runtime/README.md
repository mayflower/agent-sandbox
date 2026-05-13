# LangChain DeepAgents Sandbox Runtime

Container image source for the runtime that sits inside a `Sandbox` Pod
provisioned via the `langchain-agent-sandbox` adapter. Mirrors the HTTP
contract of `examples/python-runtime-sandbox` (so any consumer of the
agent-sandbox SDK can talk to it) but with two differences relevant to
deepagents-style agents:

- **Base directory is not hardcoded.** Resolved at startup from
  `$SANDBOX_RUNTIME_DIR` if set, otherwise from `os.getcwd()` (the
  container's `WORKDIR`). Default `WORKDIR` is `/workspace` — the
  conventional deepagents working directory — but a downstream image
  can pick any path without forking this source.
- **`ripgrep` and `git` are installed.** deepagents tools routinely
  shell out to both; keeping them in the base image avoids a per-pod
  install cost.

## Build

```sh
docker build -t langchain-deepagents-runtime:latest examples/langchain-deepagents-runtime/
```

For multi-arch builds (the CI workflow does this automatically for
mayflower-production pushes):

```sh
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t ghcr.io/<org>/agent-sandbox/langchain-deepagents-runtime:latest \
    examples/langchain-deepagents-runtime/
```

## Endpoints

| Method | Path                       | Purpose                                           |
| ------ | -------------------------- | ------------------------------------------------- |
| GET    | `/`                        | Liveness + reports the resolved `base_dir`.       |
| POST   | `/execute`                 | Run a shell command (`cwd=base_dir`).             |
| POST   | `/upload`                  | Save an uploaded file under `base_dir`.           |
| GET    | `/download/{path:path}`    | Stream a file under `base_dir`.                   |
| GET    | `/list/{path:path}`        | List directory entries (name/size/type/mod_time). |
| GET    | `/exists/{path:path}`      | Existence check.                                  |

All file-path arguments are resolved relative to `base_dir` and refused
if they escape it (path-traversal defense).

## Configuration

| Environment variable    | Default        | Meaning                                                                            |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `SANDBOX_RUNTIME_DIR`   | `os.getcwd()`  | Overrides the resolved base directory. Useful for ephemeral redirects in tests.    |

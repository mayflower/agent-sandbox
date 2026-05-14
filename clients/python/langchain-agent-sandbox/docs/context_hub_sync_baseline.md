# Context Hub Sync Baseline

> **Snapshot — do not update.** This file is a frozen record of the
> package state immediately before `ContextHubSyncedSandboxBackend`
> was added. Test names, counts, and behavior described here are
> intentionally historical; the live source of truth is the code and
> the live tests. Do not edit to "fix drift."

Baseline observations before introducing `ContextHubSyncedSandboxBackend`. No
production code is changed at this stage.

## Test baseline

`uv run pytest -q` on `feat-langchain-deepagents-backend-dev`:

```
151 passed in 0.90s
```

All existing tests pass.

## Public API surface (`langchain_agent_sandbox/__init__.py`)

Currently exported:

- `AgentSandboxBackend` – core DeepAgents backend over `Sandbox`
- `SandboxPolicyWrapper` – deny-prefix / deny-command / audit guardrail
- `create_sandbox_backend_factory` – factory for
  `create_deep_agent(backend=...)`

## `AgentSandboxBackend` shape

- Constructor: `AgentSandboxBackend(sandbox, root_dir="/workspace",
  manage_lifecycle=False, sdk_client=None, _template=None, _namespace="default",
  _sandbox_ready_timeout=180, _labels=None, _shutdown_after_seconds=None,
  _session_id=None, _default_timeout_seconds=None)`
- Factories: `from_existing(sandbox, root_dir)`, `from_template(client,
  template_name, namespace, root_dir, sandbox_ready_timeout, labels,
  shutdown_after_seconds, session_id, default_timeout_seconds)`
- Lifecycle: sync `__enter__/__exit__` plus `__aenter__/__aexit__`. Lifecycle
  is only assumed when `manage_lifecycle=True`.
- Drain: `_track_op`/`_inflight_cv`/`_draining` – cleanup waits for inflight
  operations before deleting the claim.
- Session reattach: `from_template(session_id=...)` looks up a
  SandboxClaim by `agent-sandbox.sigs.k8s.io/session-id=<id>` label.
- `delete_all(client, namespace, best_effort, label_selector)` – best-effort
  bulk delete with optional label filter.
- `id`: `"{namespace}/{claim_name}"` once entered, else `"agent-sandbox"`.

## SandboxBackendProtocol methods

| Method | Behaviour |
|---|---|
| `execute(command, *, timeout=None)` | Runs `sh -c 'cd {root_dir} && <cmd>'`; `exit_code=-2` on timeout, `-1` on other failures. |
| `ls(path)` | Native `sandbox.files.list`; returns `FileInfo` with optional `size`, `modified_at`. |
| `read(file_path, offset, limit)` | Strict UTF-8; `offset>=len(lines)` is an error on non-empty files. |
| `write(file_path, content)` | Create-only (fails if exists); virtualizes paths under `root_dir`. |
| `edit(file_path, old, new, replace_all)` | Counts occurrences; single-occurrence semantics when `replace_all=False`. |
| `grep(pattern, path, glob)` | Literal search via `grep -rHnFZ`; NUL-delimited path parsing. |
| `glob(pattern, path)` | Native `find -L` with NUL-delimited record format; locally compiled `**` glob matcher. |
| `upload_files(files)` | Returns one `FileUploadResponse` per input; preserves input order. |
| `download_files(paths)` | Returns one `FileDownloadResponse` per input; preserves input order. |

`SandboxPolicyWrapper` proxies all methods, blocks denied prefixes and
commands, and emits an optional audit callback with `strict_audit`
fail-closed semantics.

## Path normalization

`_to_internal(path)`:

1. Strips whitespace, treats empty as `/`.
2. Rejects ASCII control characters (incl. NUL) – closes a syscall
   truncation bypass for `../etc/passwd` style sneaks.
3. Strips a `root_dir` prefix if already present, then re-roots under
   `root_dir`.
4. `posixpath.normpath`.
5. `posixpath.relpath` against `root_dir` – rejects `..` escapes.

`_internal_to_relative(internal_path)` produces the path the runtime file
API consumes (relative to WORKDIR). `_to_public(internal_path)` converts
back to the virtualized view (`/` for root_dir).

`_resolve_write_path` adds an empty-input refusal on top of `_to_internal`.

## Upload / download error codes

`FileUploadResponse.error` enum (string codes seen at runtime):

| Code | When |
|---|---|
| `None` | Success |
| `invalid_path` | `_resolve_write_path` raised `ValueError`, or parent path resolves to `not_dir` |
| `is_directory` | Target itself is a directory |
| `permission_denied` | Target or parent is unreadable / unwritable |
| `upload_failed` | Probe failures, parent-mkdir failure, write failure |
| `policy_denied` | Set only by `SandboxPolicyWrapper` |

`FileDownloadResponse.error` codes:

| Code | When |
|---|---|
| `None` | Success |
| `invalid_path` | `_to_internal` raised |
| `file_not_found` | Probe says `missing` |
| `is_directory` | Probe says `dir` |
| `permission_denied` | Probe says `denied` |
| `download_failed` | Probe failure or read failure |

Both batches preserve input order; partial success is encoded per
response without affecting siblings.

## Existing tests of interest

Filesystem coverage in `tests/test_backend.py` (151 tests total):

- `read`: missing-file error path; out-of-range offset.
- `write`: create-only refusal; absolute path virtualization;
  `_ensure_parent_dir` failure surface.
- `edit`: single-occurrence + multi-occurrence-without-`replace_all`
  refusal; `replace_all=True` success.
- `grep`: success, stderr/stdout/exit-code error fall-throughs, NUL
  delimiter handling.
- `glob`: native `find -L` parsing, `**` patterns at root, prefix,
  middle, trailing; basename fallback; character class; `re.error`.
- `ls`: `size`/`modified_at` population; `.`/`..` filter; failure
  produces empty entries + error.
- `upload_files` / `download_files`: `invalid_path`, parent-dir
  creation, exception-to-`upload_failed`/`download_failed` mapping.
- Lifecycle: `from_template` enter failure path, `manage_lifecycle=False`
  no-delete on exit, cleanup-error re-raise on happy path, cleanup
  warning on traceback-only unwind, drain via `_track_op`.
- Factory: eager provisioning, finalizer registration, finalizer
  swallowing 404, finalizer logging non-404, finalizer never warning
  on shutdown.
- Policy: denied-path canonicalization, denied-command substring match,
  upload filtering, read-passthrough, audit callback fail-open vs
  strict.

There are also `test_compile_glob_*` tests covering the local glob
compiler that the synced backend will likely want to reuse.

## Result type vocabulary the wrapper must hit

From `deepagents.backends.protocol`:

- `EditResult(path, occurrences, error)`
- `ExecuteResponse(output, exit_code, truncated)`
- `FileData(content, encoding)` returned via `ReadResult.file_data`
- `FileDownloadResponse(path, content, error)`
- `FileInfo(path, is_dir, size?, modified_at?)` (TypedDict-style)
- `FileUploadResponse(path, error)`
- `GlobResult(matches, error)`
- `GrepMatch(path, line, text)`
- `GrepResult(matches, error)`
- `LsResult(entries, error)`
- `ReadResult(file_data, error)`
- `WriteResult(path, error)`

The wrapper must always produce `matches=[]` / `entries=[]` (never
`None`) when returning `error` to stay agent-friendly.

## Risk analysis for `ContextHubSyncedSandboxBackend`

1. **Lifecycle ordering** – `__enter__` must call inner's `__enter__`
   first, then pull, then materialize. A pull failure or materialize
   failure must propagate `inner.__exit__` to avoid leaking the
   underlying sandbox (the existing drain logic in `AgentSandboxBackend`
   only fires on `__exit__`). The contract test
   `test_materialization_failure_exits_inner` enforces this.
2. **Partition-on-mount discipline** – every method must classify a
   path as in-mount vs out-of-mount and never let one side leak into
   the other. Mixed-batch order preservation must be exact (existing
   `upload_files` already promises this; the wrapper must also).
3. **Hub-first commit semantics** – the wrapper must never write to
   the inner sandbox unless the hub commit succeeded for
   `per_operation`. The current `AgentSandboxBackend.write` is
   create-only; the wrapper's default `context_write_mode="context_hub"`
   needs to be upsert-aware so existing context files can be replaced
   without first deleting.
4. **`_send_files_update`** – `AgentSandboxBackend.write/edit/upload_files`
   queues LangGraph `files` channel updates via
   `_send_files_update`. The wrapper should either delegate writes to
   the inner backend (which already emits these) or replicate the call
   for materialized paths so DeepAgents `state["files"]` stays
   consistent.
5. **Path normalization** – `mount_prefix` should be absolute,
   normalized, and reused; in-mount paths must be reduced to
   hub-relative (no leading `/`, no `..`, no control chars). Reuse the
   existing `_to_internal` invariants rather than reimplementing.
6. **Linked entries** – `AgentEntry`/`SkillEntry` from the hub are
   *not* file content; the wrapper must keep them in
   `_linked_entries` and never push them to the inner
   `upload_files`. They must also survive subsequent file-only commits
   (the hub push must not drop unchanged links).
7. **UTF-8 requirement** – the hub stores `FileEntry.content: str`. A
   non-UTF-8 upload under the mount must be refused with
   `invalid_path` so the response shape stays the same as the inner
   backend's existing error code, and so order is preserved without
   crashing the batch.
8. **Parent-commit / conflict** – every push must carry the cached
   `_commit_hash` as `parent_commit`; a 409 must translate to a
   structured `WriteResult.error` / `EditResult.error` / a per-file
   `FileUploadResponse.error` and must not touch the sandbox.
9. **Reattach hydration** – `AgentSandboxBackend` supports session
   reattach. The wrapper's `__enter__` must always re-pull on entry so
   that stale materialized context files from a previous session are
   replaced; this needs to be documented and tested.
10. **Policy composition** – `SandboxPolicyWrapper` wraps an
    `AgentSandboxBackend`-typed value. The `ContextHubSyncedSandboxBackend`
    must satisfy the same protocol (and not the concrete class). Either
    the policy wrapper must be relaxed to `SandboxBackendProtocol`, or
    the docs must make wrapper ordering explicit (Policy outside vs
    inside has different blast radius: outside blocks hub mount writes,
    inside only blocks materialization).
11. **Grep semantics divergence** – inner `grep` is literal, but
    upstream LangSmith's `ContextHubBackend.grep` is regex. The
    wrapper must stay literal to keep DeepAgents tool contract
    consistent.

# Context Hub Sync — review checklist outcome

> **Snapshot — do not update.** Frozen review note recorded at the
> end of the implementation milestone. References to test counts,
> specific test names, and "Bewusst nicht umgesetzt" knobs may drift
> from the current code; treat them as a point-in-time record.

Result of running `docs/review-checklist.md` (from the promptpack) over
the implementation on `feat-langchain-deepagents-backend-dev`.

## API

- [x] `ContextHubSyncedSandboxBackend` is importable from
      `langchain_agent_sandbox`.
- [x] Existing exports (`AgentSandboxBackend`, `SandboxPolicyWrapper`,
      `create_sandbox_backend_factory`) are unchanged.
- [x] `ContextHubClientProtocol`, exceptions, and models are
      importable from `langchain_agent_sandbox`.
- [x] No hard `langsmith` runtime dependency — only duck typing in
      `entry_from_mapping`.
- [x] LangSmith interop is documented in README ("LangSmith interop"
      section).

## Tests

- [x] All new tests were red before the corresponding implementation
      step (verified by running pytest at each boundary).
- [x] Pre-existing `test_backend.py` (151 tests) stays green.
- [x] Contract tests cover every `SandboxBackendProtocol` method
      (`tests/test_context_hub_synced_backend.py`).
- [x] Agent and skill repos are both covered (`repo_type`
      parameterized fixture).
- [x] Conflicts, tags, links, deletions all have tests
      (`test_context_hub_synced_backend.py`,
      `test_context_hub_client_contract.py`,
      `test_context_hub_http_client.py`).
- [x] Non-UTF-8 uploads under the mount return `invalid_path` and do
      not poison the batch commit
      (`test_upload_context_batch_rejects_non_utf8_but_commits_valid`).

## Sync

- [x] `__enter__` materializes `FileEntry` content under the mount
      prefix and skips linked entries
      (`test_enter_calls_inner_enter_then_pulls_then_materializes`).
- [x] Hydration failure calls `inner.__exit__` so the sandbox does
      not leak
      (`test_materialization_failure_calls_inner_exit_and_reraises`,
      `test_policy_inside_blocks_inner_materialization_only`).
- [x] `execute()` sees materialized files
      (`test_execute_reads_hydrated_file_via_inner_shell`).
- [x] Write/edit/upload are hub-first in `per_operation`
      (`test_write_context_is_hub_first_then_materializes`,
      `test_edit_context_commits_and_counts_occurrences`,
      `test_upload_context_only_batch_makes_single_commit`).
- [x] On hub failure, sandbox stays unchanged
      (`test_write_context_hub_failure_does_not_modify_sandbox`,
      `test_edit_context_hub_conflict_keeps_sandbox`,
      `test_upload_context_hub_failure_marks_only_context_paths_failed`).
- [x] `on_exit` and `manual` modes are tested and documented
      (`test_on_exit_buffers_until_close`,
      `test_manual_only_flushes_on_explicit_call`).

## Security

- [x] Path traversal blocked: `_to_hub_path` rejects `..` traversal
      after normalization
      (`test_write_context_invalid_path_returns_error_no_push`,
      `_claims_mount` detects traversal that escapes the mount).
- [x] Control characters and NUL bytes rejected by `_normalize_input`.
- [x] No secret logging: HTTP client logs use the response message
      field, never the auth header.
- [x] `SandboxPolicyWrapper` still works around the synced backend
      (`test_policy_outside_blocks_context_writes`).

## Documentation

- [x] README has a "Context Hub sync" section with usage example,
      factory pattern, and LangSmith interop.
- [x] API reference is implicit in the dataclasses' docstrings;
      `ContextHubSyncedSandboxBackend` docstring covers the
      constructor.
- [x] Error / conflict semantics are documented in the README ("Hub-
      first commit semantics").

## Tooling

- [x] `uv run pytest -q` — 319 passed.
- [x] `uv run python -m compileall langchain_agent_sandbox tests` —
      clean.
- [x] `uv run ruff check langchain_agent_sandbox tests` — clean.
- [x] `uv run mypy langchain_agent_sandbox` — the new files
      (`context_hub_models.py`, `context_hub_client.py`,
      `context_hub_sync.py`, `context_hub_http_client.py`) have
      no errors. Pre-existing `backend.py` mypy errors are
      out-of-scope.

## Promptpack-Lücken (geschlossen)

Audit gegen `00-research-notes.md` und `docs/backend-invariants.md`
nach P08:

| Lücke | Status |
|---|---|
| `pyproject.toml` deklariert `httpx>=0.27` | ✓ |
| Default-Pfad-Ausschlüsse (`.git`, `.env`, `node_modules`, …) unter dem Mount | ✓ — `_DEFAULT_EXCLUDED_GLOBS` + 11 parametrized Tests |
| `excluded_globs` per-Backend Override | ✓ — `test_exclusions_can_be_overridden_per_backend` |
| `materialize_linked=True` schreibt JSON-Pointer-Dateien | ✓ — 3 Tests |
| Mixed-root Aggregation für `ls`/`glob`/`grep` bei `path="/"` | ✓ — funktioniert via Materialisierung; 4 Tests |
| Wrapper-Reihenfolge dokumentiert | ✓ — Tabelle im README |
| Snapshot-Limits: `max_files`, `max_total_bytes`, `max_file_bytes` | ✓ — 4 Tests |
| Migrationshinweise `CompositeBackend` / `ContextHubBackend` | ✓ — README-Sektion |

## Bewusst nicht umgesetzt

Aus `docs/implementation-blueprint.md` aufgeführte optionale
Konstruktor-Knobs ohne zugehörigen Prompt-Test:

* `conflict_strategy: Literal["error", "refresh"]` — aktuell
  immer `"error"`. Cache wird bei 409 als stale markiert
  (`_cache_stale`), die Strategy-Switch wäre Convenience für
  automatisches `refresh()` + Merge — nicht im Promptpack-Test-Plan.
* `include_globs` — Whitelist-Pendant zu `excluded_globs`.
* `materialize_on_enter` / `materialize_on_flush` /
  `read_your_writes` — diese drei sind aktuell hart auf `True`
  gepinned. Toggle wäre nur sinnvoll, wenn ein Caller einen lazy
  Read-Through Cache will.
* `refresh(*, discard_dirty=False)` Public-Method — bei Bedarf
  trivial nachreichbar.

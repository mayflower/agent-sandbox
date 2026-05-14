# Copyright 2026 The Kubernetes Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Context Hub mount wrapper for any SandboxBackendProtocol.

The wrapper treats one absolute mount point (default ``/context``) as
a virtual filesystem backed by a versioned Context Hub repo. Non-mount
paths pass through to the inner backend unchanged.
"""

from __future__ import annotations

import json
import logging
import posixpath
import re
import weakref
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Literal,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    Union,
)

from deepagents.backends.protocol import (
    EditResult,
    ExecuteResponse,
    FileData,
    FileDownloadResponse,
    FileInfo,
    FileUploadResponse,
    GlobResult,
    GrepMatch,
    GrepResult,
    LsResult,
    ReadResult,
    SandboxBackendProtocol,
    WriteResult,
)

from .context_hub_client import (
    ContextHubClientProtocol,
    HubConflictError,
    HubError,
    HubNotFoundError,
)
from .context_hub_models import (
    AgentContext,
    AgentEntry,
    Entry,
    FileEntry,
    SkillContext,
    SkillEntry,
    entry_to_mapping,
    parse_context_hub_identifier,
)

logger = logging.getLogger(__name__)

CommitMode = Literal["per_operation", "on_exit", "manual"]
ContextWriteMode = Literal["context_hub", "deepagents"]
RepoType = Literal["agent", "skill"]


# Default deny-list for paths that should never live in a versioned
# context hub. Globs are matched against the *hub-relative* path
# (no leading slash). Each pattern follows the same syntax as
# :func:`_compile_glob`. Operators can override by passing
# ``excluded_globs=[...]`` to the wrapper.
_DEFAULT_EXCLUDED_GLOBS: Sequence[str] = (
    ".git",
    ".git/**",
    ".hg",
    ".hg/**",
    ".svn",
    ".svn/**",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "node_modules",
    "node_modules/**",
    "**/node_modules/**",
    "__pycache__",
    "__pycache__/**",
    "**/__pycache__/**",
    ".venv",
    ".venv/**",
    "**/.venv/**",
    "dist",
    "dist/**",
    "build",
    "build/**",
)

# Safety nets so a runaway context hub cannot exhaust local memory or
# slot quota when the wrapper hydrates a snapshot.
_DEFAULT_MAX_FILES = 10_000
_DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024  # 100 MiB
_DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024    # 10 MiB

# Chunk size for the hydration upload to the inner sandbox. Each inner
# upload tends to round-trip per file through the sandbox runtime, so
# a 10k-file snapshot in one batch can hit request-size limits or
# block ``execute()`` for many minutes. 200 keeps the per-batch cost
# bounded without making setup chatty.
_DEFAULT_MATERIALIZE_CHUNK_SIZE = 200


class ContextHubSyncedSandboxBackend(SandboxBackendProtocol):
    """Materializes a Context Hub snapshot into an inner sandbox backend."""

    def __init__(
        self,
        inner: SandboxBackendProtocol,
        hub_client: ContextHubClientProtocol,
        identifier: str,
        *,
        repo_type: RepoType = "agent",
        mount_prefix: str = "/context",
        version: Optional[str] = None,
        commit_mode: CommitMode = "per_operation",
        context_write_mode: ContextWriteMode = "context_hub",
        materialize_linked: bool = False,
        excluded_globs: Optional[Sequence[str]] = None,
        max_files: int = _DEFAULT_MAX_FILES,
        max_total_bytes: int = _DEFAULT_MAX_TOTAL_BYTES,
        max_file_bytes: int = _DEFAULT_MAX_FILE_BYTES,
        materialize_chunk_size: int = _DEFAULT_MATERIALIZE_CHUNK_SIZE,
    ) -> None:
        if not mount_prefix.startswith("/"):
            raise ValueError(
                f"mount_prefix must be absolute, got: {mount_prefix!r}"
            )
        normalized = posixpath.normpath(mount_prefix)
        if normalized == "/":
            raise ValueError("mount_prefix must not be '/'")
        # Parse here so identifier mistakes surface immediately rather
        # than on the first __enter__.
        self._parsed_identifier = parse_context_hub_identifier(
            identifier, version=version
        )
        self._inner: SandboxBackendProtocol = inner
        self._hub: ContextHubClientProtocol = hub_client
        self._identifier = identifier
        self._repo_type: RepoType = repo_type
        self._mount_prefix = normalized
        self._mount_prefix_slash = normalized + "/"
        self._version = version
        self._commit_mode: CommitMode = commit_mode
        self._context_write_mode: ContextWriteMode = context_write_mode
        self._materialize_linked = materialize_linked
        # ``None`` falls back to :data:`_DEFAULT_EXCLUDED_GLOBS`; an
        # empty list explicitly disables exclusions. We freeze to a
        # tuple so the matchers below can be safely memoised later.
        self._excluded_globs: tuple[str, ...] = tuple(
            _DEFAULT_EXCLUDED_GLOBS if excluded_globs is None else excluded_globs
        )
        self._excluded_matchers = [
            _compile_glob(pattern) for pattern in self._excluded_globs
        ]
        self._max_files = max_files
        self._max_total_bytes = max_total_bytes
        self._max_file_bytes = max_file_bytes
        if materialize_chunk_size < 1:
            raise ValueError(
                f"materialize_chunk_size must be >= 1, got {materialize_chunk_size}"
            )
        self._materialize_chunk_size = materialize_chunk_size

        self._cache: Dict[str, str] = {}
        self._linked_entries: Dict[str, Entry] = {}
        self._commit_hash: Optional[str] = None
        self._commit_id: Optional[str] = None
        self._cache_stale = False
        self._dirty_files: Dict[str, Optional[str]] = {}
        self._inner_entered = False

    def __enter__(self) -> "ContextHubSyncedSandboxBackend":
        # The inner backend may or may not be a context manager (e.g.
        # tests can pass a plain protocol instance). We tolerate both.
        enter = getattr(self._inner, "__enter__", None)
        if callable(enter):
            enter()
            self._inner_entered = True
        try:
            self._reset_state()
            self._pull_context()
            self._materialize_all()
        except BaseException:
            # Make sure the inner sandbox is torn down if hydration
            # fails — otherwise a from_template-managed inner leaks a
            # claim every time the hub pull or materialize step fails.
            self._safe_inner_exit()
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        flush_error: Optional[BaseException] = None
        # Always attempt the on_exit flush, even if the body raised —
        # otherwise an agent that crashes mid-session silently loses
        # all buffered hub writes. When the body already raised, the
        # flush error gets logged but not re-raised (Python semantics:
        # __exit__ swallowing produces a confusing chained traceback).
        if self._commit_mode == "on_exit" and self._dirty_files:
            try:
                self.flush()
            except BaseException as flush_exc:
                flush_error = flush_exc
                if exc_type is not None:
                    logger.error(
                        "on_exit flush failed during exception unwind for %s: %s",
                        self._identifier, flush_exc,
                    )
        try:
            self._safe_inner_exit(exc_type, exc, tb)
        finally:
            if flush_error is not None and exc_type is None:
                raise flush_error

    async def __aenter__(self) -> "ContextHubSyncedSandboxBackend":
        return self.__enter__()

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self.__exit__(exc_type, exc, tb)

    def _safe_inner_exit(
        self, exc_type: Any = None, exc: Any = None, tb: Any = None
    ) -> None:
        if not self._inner_entered:
            return
        exit_fn = getattr(self._inner, "__exit__", None)
        if not callable(exit_fn):
            self._inner_entered = False
            return
        try:
            exit_fn(exc_type, exc, tb)
        except Exception as e:
            # The inner sandbox's teardown is the only chance to delete
            # a managed claim; a failure here means the claim leaks
            # until the controller GCs it. That's an ops-visible event,
            # not a warning.
            logger.exception(
                "inner backend __exit__ failed for %s (claim may leak): %s",
                self._identifier, e,
            )
        finally:
            self._inner_entered = False

    def _reset_state(self) -> None:
        self._cache = {}
        self._linked_entries = {}
        self._commit_hash = None
        self._commit_id = None
        self._cache_stale = False
        self._dirty_files = {}

    def _pull_context(self) -> None:
        ctx: Union[AgentContext, SkillContext]
        try:
            if self._repo_type == "agent":
                ctx = self._hub.pull_agent(
                    self._identifier, version=self._version
                )
            else:
                ctx = self._hub.pull_skill(
                    self._identifier, version=self._version
                )
        except HubNotFoundError:
            # Empty-on-not-found is a real first-use case (no commit
            # has been pushed yet). Log so a typo in the identifier
            # is at least diagnosable from the logs — silent empty
            # /context is otherwise indistinguishable from misconfig.
            logger.info(
                "context hub %s@%s not found; starting with empty context",
                self._identifier, self._version or "HEAD",
            )
            self._commit_hash = None
            self._commit_id = None
            return
        self._commit_hash = ctx.commit_hash
        self._commit_id = ctx.commit_id
        self._enforce_snapshot_limits(ctx.files)
        self._hydrate_cache_from_context(ctx.files)

    def _enforce_snapshot_limits(self, files: Mapping[str, Entry]) -> None:
        """Refuse to hydrate a snapshot that would exceed local limits.

        ``HubError`` is raised before any sandbox write so the lifecycle
        manager can tear the inner backend down cleanly.
        """
        file_count = 0
        total_bytes = 0
        for path, entry in files.items():
            if isinstance(entry, FileEntry):
                file_count += 1
                size = len(entry.content.encode("utf-8"))
                if size > self._max_file_bytes:
                    raise HubError(
                        f"snapshot file {path!r} is {size} bytes which "
                        f"exceeds max_file_bytes={self._max_file_bytes}"
                    )
                total_bytes += size
        if file_count > self._max_files:
            raise HubError(
                f"snapshot contains {file_count} files which exceeds "
                f"max_files={self._max_files}"
            )
        if total_bytes > self._max_total_bytes:
            raise HubError(
                f"snapshot is {total_bytes} bytes which exceeds "
                f"max_total_bytes={self._max_total_bytes}"
            )

    def _hydrate_cache_from_context(
        self, files: Mapping[str, Entry]
    ) -> None:
        dropped: list[str] = []
        for path, entry in files.items():
            if self._is_excluded_hub_path(path):
                dropped.append(path)
                continue
            if isinstance(entry, FileEntry):
                self._cache[path] = entry.content
            elif isinstance(entry, (AgentEntry, SkillEntry)):
                self._linked_entries[path] = entry
        if dropped:
            # Hub snapshots can carry artifacts that the deny-list
            # forbids writing fresh (e.g. a `.env` shipped before the
            # exclusion was added). Drop them on read too — otherwise
            # the sandbox would expose data the policy says it can't.
            logger.warning(
                "context hub %s: dropped %d entries matching exclude list: %s",
                self._identifier, len(dropped), dropped,
            )

    def _materialize_all(self) -> None:
        payload: List[Tuple[str, bytes]] = []
        for hub_path, content in self._cache.items():
            mount_path = self._to_mount_path(hub_path)
            payload.append((mount_path, content.encode("utf-8")))
        if self._materialize_linked and self._linked_entries:
            payload.extend(self._link_materialization_payload())
        if not payload:
            return
        failures: List[FileUploadResponse] = []
        chunk = self._materialize_chunk_size
        for start in range(0, len(payload), chunk):
            batch = payload[start : start + chunk]
            responses = self._inner.upload_files(batch)
            failures.extend(r for r in responses if r.error is not None)
        if failures:
            raise HubError(
                "failed to materialize Context Hub snapshot into sandbox: "
                + ", ".join(f"{r.path}: {r.error}" for r in failures)
            )

    def _link_materialization_payload(self) -> List[Tuple[str, bytes]]:
        """Render Agent/Skill links as JSON pointer files."""
        payload: List[Tuple[str, bytes]] = []
        for hub_path, entry in self._linked_entries.items():
            mount_path = self._to_mount_path(hub_path)
            body = json.dumps(entry_to_mapping(entry), sort_keys=True)
            payload.append((mount_path, body.encode("utf-8")))
        return payload

    def _check_write_size(self, file_path: str, content: str) -> Optional[str]:
        size = len(content.encode("utf-8"))
        if size > self._max_file_bytes:
            return (
                f"Path '{file_path}' is {size} bytes which exceeds "
                f"max_file_bytes={self._max_file_bytes} size limit"
            )
        return None

    def _normalize_input(self, path: str) -> str:
        candidate = path.strip()
        if not candidate:
            return "/"
        if any(ord(c) < 0x20 for c in candidate):
            raise ValueError(
                f"path contains control characters: {path!r}"
            )
        if not candidate.startswith("/"):
            candidate = "/" + candidate
        return posixpath.normpath(candidate)

    def _is_context_path(self, path: str) -> bool:
        normalized = self._normalize_input(path)
        return (
            normalized == self._mount_prefix
            or normalized.startswith(self._mount_prefix_slash)
        )

    # SandboxPolicyWrapper compatibility — the wrapper canonicalises
    # deny prefixes through these internal helpers. We satisfy them by
    # routing context-mount paths through ``_to_hub_path`` (then back
    # into the mount) and delegating everything else to the inner
    # backend. This keeps ``SandboxPolicyWrapper(synced_backend, ...)``
    # working with the same deny-prefix vocabulary the docs describe.

    def _to_internal(self, path: str) -> str:
        if self._is_context_path(path):
            return self._to_mount_path(self._to_hub_path(path))
        inner_method = getattr(self._inner, "_to_internal", None)
        if callable(inner_method):
            return inner_method(path)
        return self._normalize_input(path)

    def _resolve_write_path(self, path: str) -> str:
        if not path or not path.strip():
            raise ValueError("empty path")
        return self._to_internal(path)

    def _is_excluded_hub_path(self, hub_path: str) -> bool:
        """Return ``True`` if writes to ``hub_path`` should be refused.

        The check runs against the hub-relative path (no leading slash)
        so a context mount at ``/context`` excludes ``.env`` whether the
        caller addresses it as ``/context/.env`` or as ``.env`` inside
        ``_push_files``.
        """
        if not hub_path or not self._excluded_matchers:
            return False
        return any(matcher(hub_path) for matcher in self._excluded_matchers)

    def _claims_mount(self, raw_path: str) -> bool:
        """Did the caller *try* to address the mount, regardless of escape?

        Catches paths like ``/context/../escape.md`` that normalize out
        of the mount: those are traversal attempts that must be refused,
        not silently delegated to the inner backend.
        """
        candidate = raw_path.strip()
        if not candidate:
            return False
        if not candidate.startswith("/"):
            candidate = "/" + candidate
        return (
            candidate == self._mount_prefix
            or candidate.startswith(self._mount_prefix_slash)
        )

    def _to_hub_path(self, path: str) -> str:
        """Map an absolute mount path to its hub-relative form.

        Raises ``ValueError`` for paths outside the mount or for paths
        with ``..`` traversal that escapes the mount.
        """
        normalized = self._normalize_input(path)
        if normalized == self._mount_prefix:
            return ""
        if not normalized.startswith(self._mount_prefix_slash):
            raise ValueError(
                f"path {path!r} is outside mount {self._mount_prefix!r}"
            )
        rel = normalized[len(self._mount_prefix_slash):]
        # Sanity check — even after normpath, refuse anything that walks
        # up out of the mount.
        if rel.startswith("../") or rel == "..":
            raise ValueError(
                f"path {path!r} escapes mount {self._mount_prefix!r}"
            )
        return rel

    def _to_mount_path(self, hub_path: str) -> str:
        if not hub_path:
            return self._mount_prefix
        return self._mount_prefix_slash + hub_path.lstrip("/")

    @property
    def id(self) -> str:
        inner_id = getattr(self._inner, "id", None) or "inner"
        parts = [f"context-hub:{self._parsed_identifier.owner}/"
                 f"{self._parsed_identifier.name}"]
        if self._parsed_identifier.version:
            parts[0] += f":{self._parsed_identifier.version}"
        parts.append(inner_id)
        return "+".join(parts)

    def has_prior_commits(self) -> bool:
        """``True`` if the loaded snapshot has a non-empty commit hash."""
        return self._commit_hash is not None

    def get_linked_entries(self) -> Dict[str, Entry]:
        """Defensive copy of linked Agent/Skill entries from the snapshot."""
        return dict(self._linked_entries)

    def pending_changes(self) -> Tuple[str, ...]:
        """Hub-relative paths waiting for the next flush.

        Empty under ``per_operation`` (changes are pushed synchronously).
        For ``on_exit``/``manual`` it reflects the buffer that the next
        ``flush()`` (or context-manager exit, for ``on_exit``) will send.
        """
        return tuple(self._dirty_files)

    def is_cache_stale(self) -> bool:
        """``True`` after a conflict or post-commit materialization fail."""
        return self._cache_stale

    def execute(
        self, command: str, *, timeout: Optional[int] = None
    ) -> ExecuteResponse:
        return self._inner.execute(command, timeout=timeout)

    def ls(self, path: str) -> LsResult:
        if self._is_context_path(path):
            try:
                hub_path = self._to_hub_path(path)
            except ValueError as e:
                return LsResult(entries=[], error=str(e))
            return LsResult(entries=list(self._ls_cache(hub_path)))
        if self._claims_mount(path):
            return LsResult(
                entries=[],
                error=(
                    f"Path '{path}' escapes mount '{self._mount_prefix}'"
                ),
            )
        return self._inner.ls(path)

    def _ls_cache(self, hub_dir: str) -> Iterable[FileInfo]:
        prefix = hub_dir + "/" if hub_dir else ""
        seen_dirs: set[str] = set()
        entries: List[FileInfo] = []
        items: List[Tuple[str, str | None]] = [
            (p, content) for p, content in self._cache.items()
        ]
        items += [(p, None) for p in self._linked_entries.keys()]
        for hub_path, content in items:
            if hub_dir and not hub_path.startswith(prefix):
                continue
            rest = hub_path[len(prefix):]
            if not rest:
                continue
            head, sep, _ = rest.partition("/")
            public = self._to_mount_path((hub_dir + "/" + head) if hub_dir else head)
            if sep:
                if public not in seen_dirs:
                    seen_dirs.add(public)
                    entries.append(FileInfo(path=public, is_dir=True))
            else:
                info = FileInfo(path=public, is_dir=False)
                if isinstance(content, str):
                    info["size"] = len(content.encode("utf-8"))
                entries.append(info)
        entries.sort(key=lambda e: e["path"])
        return entries

    def read(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = 2000,
    ) -> ReadResult:
        if not self._is_context_path(file_path):
            if self._claims_mount(file_path):
                return ReadResult(
                    error=(
                        f"Path '{file_path}' escapes mount "
                        f"'{self._mount_prefix}'"
                    )
                )
            return self._inner.read(file_path, offset, limit)
        try:
            hub_path = self._to_hub_path(file_path)
        except ValueError as e:
            return ReadResult(error=str(e))
        if hub_path not in self._cache:
            return ReadResult(
                error=f"File '{file_path}' not found in context"
            )
        text = self._cache[hub_path]
        lines = text.splitlines()
        if not lines:
            return ReadResult(file_data=FileData(content="", encoding="utf-8"))
        start = max(0, offset)
        if start >= len(lines):
            return ReadResult(
                error=(
                    f"Line offset {offset} exceeds file length "
                    f"({len(lines)} lines)"
                )
            )
        end = min(len(lines), start + limit)
        return ReadResult(
            file_data=FileData(
                content="\n".join(lines[start:end]), encoding="utf-8"
            )
        )

    def write(self, file_path: str, content: str) -> WriteResult:
        if not self._is_context_path(file_path):
            if self._claims_mount(file_path):
                return WriteResult(
                    error=(
                        f"Error: path '{file_path}' escapes mount "
                        f"'{self._mount_prefix}'"
                    ),
                    path=file_path,
                )
            return self._inner.write(file_path, content)
        try:
            hub_path = self._to_hub_path(file_path)
        except ValueError as e:
            return WriteResult(
                error=f"Error: Invalid path '{file_path}': {e}",
                path=file_path,
            )
        if not hub_path:
            return WriteResult(
                error=f"Error: cannot write to mount root '{file_path}'",
                path=file_path,
            )
        if self._is_excluded_hub_path(hub_path):
            return WriteResult(
                error=(
                    f"Path '{file_path}' is on the context-hub exclude list"
                ),
                path=file_path,
            )
        size_error = self._check_write_size(file_path, content)
        if size_error is not None:
            return WriteResult(error=size_error, path=file_path)
        if self._context_write_mode == "deepagents" and (
            hub_path in self._cache or hub_path in self._dirty_files
        ):
            return WriteResult(
                error=f"File '{file_path}' already exists",
                path=file_path,
            )
        commit_error = self._stage_change(hub_path, content)
        if commit_error is not None:
            return WriteResult(error=commit_error, path=file_path)
        materialize_error = self._materialize_one(hub_path, content)
        if materialize_error is not None:
            return WriteResult(error=materialize_error, path=file_path)
        return WriteResult(path=file_path)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self._is_context_path(file_path):
            return self._inner.edit(file_path, old_string, new_string, replace_all)
        try:
            hub_path = self._to_hub_path(file_path)
        except ValueError as e:
            return EditResult(
                error=f"Error: Invalid path '{file_path}': {e}",
                path=file_path,
                occurrences=0,
            )
        if self._is_excluded_hub_path(hub_path):
            return EditResult(
                error=(
                    f"Path '{file_path}' is on the context-hub exclude list"
                ),
                path=file_path,
                occurrences=0,
            )
        if hub_path not in self._cache:
            return EditResult(
                error=f"File '{file_path}' not found in context",
                path=file_path,
                occurrences=0,
            )
        current = self._cache[hub_path]
        occurrences = current.count(old_string)
        if occurrences == 0:
            return EditResult(
                error=f"Error: String not found in file: '{old_string}'",
                path=file_path,
                occurrences=0,
            )
        if not replace_all and occurrences > 1:
            return EditResult(
                error=(
                    f"Error: String '{old_string}' appears multiple times. "
                    "Use replace_all=True to replace all occurrences."
                ),
                path=file_path,
                occurrences=occurrences,
            )
        updated = (
            current.replace(old_string, new_string)
            if replace_all
            else current.replace(old_string, new_string, 1)
        )
        size_error = self._check_write_size(file_path, updated)
        if size_error is not None:
            return EditResult(
                error=size_error, path=file_path, occurrences=0
            )
        commit_error = self._stage_change(hub_path, updated)
        if commit_error is not None:
            return EditResult(
                error=commit_error, path=file_path, occurrences=0
            )
        materialize_error = self._materialize_one(hub_path, updated)
        if materialize_error is not None:
            return EditResult(
                error=materialize_error, path=file_path, occurrences=0
            )
        return EditResult(
            path=file_path,
            occurrences=occurrences if replace_all else 1,
        )

    def grep(
        self,
        pattern: str,
        path: Optional[str] = None,
        glob: Optional[str] = None,
    ) -> GrepResult:
        target = path or "/"
        if self._is_context_path(target):
            try:
                return GrepResult(
                    matches=list(self._grep_cache(pattern, target, glob))
                )
            except ValueError as e:
                return GrepResult(matches=[], error=str(e))
        if self._claims_mount(target):
            return GrepResult(
                matches=[],
                error=(
                    f"Path '{target}' escapes mount '{self._mount_prefix}'"
                ),
            )
        return self._inner.grep(pattern, path, glob)

    def _grep_cache(
        self,
        pattern: str,
        base: str,
        glob: Optional[str],
    ) -> Iterable[GrepMatch]:
        hub_base = self._to_hub_path(base)
        matcher = _compile_glob(glob) if glob else None
        prefix = hub_base + "/" if hub_base else ""
        results: List[GrepMatch] = []
        for hub_path, content in self._cache.items():
            if hub_base and not hub_path.startswith(prefix) and hub_path != hub_base:
                continue
            if matcher is not None and not matcher(hub_path):
                continue
            for line_no, line in enumerate(content.splitlines(), start=1):
                if pattern in line:
                    results.append(
                        GrepMatch(
                            path=self._to_mount_path(hub_path),
                            line=line_no,
                            text=line,
                        )
                    )
        results.sort(key=lambda m: (m["path"], m["line"]))
        return results

    def glob(self, pattern: str, path: str = "/") -> GlobResult:
        if self._is_context_path(path):
            try:
                return GlobResult(
                    matches=list(self._glob_cache(pattern, path))
                )
            except ValueError as e:
                return GlobResult(matches=[], error=str(e))
        if self._claims_mount(path):
            return GlobResult(
                matches=[],
                error=(
                    f"Path '{path}' escapes mount '{self._mount_prefix}'"
                ),
            )
        return self._inner.glob(pattern, path)

    def _glob_cache(self, pattern: str, base: str) -> Iterable[FileInfo]:
        hub_base = self._to_hub_path(base)
        normalized_pattern = pattern.lstrip("/")
        matcher = _compile_glob(normalized_pattern)
        prefix = hub_base + "/" if hub_base else ""
        matches: List[FileInfo] = []
        for hub_path, content in self._cache.items():
            if hub_base and not hub_path.startswith(prefix):
                continue
            rel = hub_path[len(prefix):] if prefix else hub_path
            if matcher(rel):
                matches.append(
                    FileInfo(
                        path=self._to_mount_path(hub_path),
                        is_dir=False,
                        size=len(content.encode("utf-8")),
                    )
                )
        matches.sort(key=lambda e: e["path"])
        return matches

    def upload_files(
        self,
        files: Union[Dict[str, bytes], Iterable[Tuple[str, bytes]]],
    ) -> List[FileUploadResponse]:
        pairs: List[Tuple[str, bytes]] = (
            list(files.items()) if isinstance(files, dict) else list(files)
        )
        responses: List[Optional[FileUploadResponse]] = [None] * len(pairs)
        # Step 1: classify each entry and pre-decode context payloads.
        # Order tracking keeps the response slot stable per input index.
        context_indices: List[int] = []
        # hub_path -> last-write-wins text content
        context_decoded: Dict[str, str] = {}
        context_hub_paths: List[Optional[str]] = [None] * len(pairs)
        inner_pairs: List[Tuple[int, str, bytes]] = []
        for idx, (path, payload) in enumerate(pairs):
            if not self._is_context_path(path):
                if self._claims_mount(path):
                    responses[idx] = FileUploadResponse(
                        path=path, error="invalid_path"
                    )
                    continue
                inner_pairs.append((idx, path, payload))
                continue
            try:
                hub_path = self._to_hub_path(path)
            except ValueError:
                responses[idx] = FileUploadResponse(
                    path=path, error="invalid_path"
                )
                continue
            if not hub_path:
                responses[idx] = FileUploadResponse(
                    path=path, error="invalid_path"
                )
                continue
            if self._is_excluded_hub_path(hub_path):
                responses[idx] = FileUploadResponse(
                    path=path, error="excluded"
                )
                continue
            if len(payload) > self._max_file_bytes:
                responses[idx] = FileUploadResponse(
                    path=path, error="too_large"
                )
                continue
            try:
                text = payload.decode("utf-8")
            except UnicodeDecodeError:
                responses[idx] = FileUploadResponse(
                    path=path, error="not_utf8"
                )
                continue
            context_indices.append(idx)
            context_hub_paths[idx] = hub_path
            # Last-write-wins for duplicate hub paths in the same batch.
            context_decoded[hub_path] = text

        # Step 2: commit the deduplicated context batch hub-first.
        commit_error: Optional[str] = None
        if context_decoded:
            commit_error = self._commit_batch(context_decoded)

        # Step 3: materialize successful context files into the sandbox.
        if context_indices:
            if commit_error is not None:
                for idx in context_indices:
                    if responses[idx] is None:
                        responses[idx] = FileUploadResponse(
                            path=pairs[idx][0],
                            error="upload_failed",
                        )
            else:
                inner_context_batch: List[Tuple[str, bytes]] = []
                for hub_path, text in context_decoded.items():
                    inner_context_batch.append(
                        (self._to_mount_path(hub_path), text.encode("utf-8"))
                    )
                inner_responses = self._inner.upload_files(inner_context_batch)
                inner_by_mount: Dict[str, FileUploadResponse] = {
                    resp.path: resp for resp in inner_responses
                }
                for idx in context_indices:
                    optional_hub_path = context_hub_paths[idx]
                    assert optional_hub_path is not None
                    hub_path = optional_hub_path
                    mount_path = self._to_mount_path(hub_path)
                    inner_resp = inner_by_mount.get(mount_path)
                    if inner_resp is not None and inner_resp.error is None:
                        responses[idx] = FileUploadResponse(
                            path=pairs[idx][0], error=None
                        )
                    else:
                        # Hub commit already happened; mark divergence
                        # so the caller knows cache and sandbox forked.
                        detail = (
                            inner_resp.error
                            if inner_resp is not None
                            else "no response from inner sandbox"
                        )
                        self._on_materialize_after_commit_failure(
                            hub_path, str(detail)
                        )
                        err = (
                            inner_resp.error
                            if inner_resp is not None
                            else "upload_failed"
                        )
                        responses[idx] = FileUploadResponse(
                            path=pairs[idx][0],
                            error=err,
                        )

        # Step 4: send the inner-only batch in original order, then map back.
        if inner_pairs:
            inner_only_batch = [(p, payload) for _, p, payload in inner_pairs]
            inner_responses = self._inner.upload_files(inner_only_batch)
            for (idx, _, _), resp in zip(inner_pairs, inner_responses):
                responses[idx] = resp

        return [r for r in responses if r is not None]

    def download_files(
        self, paths: Iterable[str]
    ) -> List[FileDownloadResponse]:
        path_list = list(paths)
        responses: List[FileDownloadResponse] = []
        for path in path_list:
            if self._is_context_path(path):
                try:
                    hub_path = self._to_hub_path(path)
                except ValueError as e:
                    responses.append(
                        FileDownloadResponse(
                            path=path, content=None, error="invalid_path"
                        )
                    )
                    logger.debug("download invalid path %s: %s", path, e)
                    continue
                if hub_path in self._cache:
                    responses.append(
                        FileDownloadResponse(
                            path=path,
                            content=self._cache[hub_path].encode("utf-8"),
                            error=None,
                        )
                    )
                else:
                    responses.append(
                        FileDownloadResponse(
                            path=path, content=None, error="file_not_found"
                        )
                    )
            elif self._claims_mount(path):
                responses.append(
                    FileDownloadResponse(
                        path=path, content=None, error="invalid_path"
                    )
                )
            else:
                inner_resp = self._inner.download_files([path])
                responses.extend(inner_resp)
        return responses

    def _stage_change(
        self, hub_path: str, content: str
    ) -> Optional[str]:
        """Stage one file change, committing immediately for per_operation.

        Returns ``None`` on success, otherwise a human-readable error
        message. On hub failure the cache and dirty buffer are left
        unchanged so the sandbox is never written.
        """
        if self._commit_mode == "per_operation":
            commit_error = self._push_files({hub_path: content})
            if commit_error is not None:
                return commit_error
            self._cache[hub_path] = content
            return None
        # Buffered modes — keep the change in memory.
        self._cache[hub_path] = content
        self._dirty_files[hub_path] = content
        return None

    def _commit_batch(
        self, batch: Dict[str, str]
    ) -> Optional[str]:
        """Commit a batch of file changes.

        Same return contract as :meth:`_stage_change` but for an
        atomic multi-file push.
        """
        if self._commit_mode == "per_operation":
            commit_error = self._push_files(batch)
            if commit_error is not None:
                return commit_error
            self._cache.update(batch)
            return None
        # Buffered modes: stage in cache + dirty buffer.
        self._cache.update(batch)
        self._dirty_files.update(batch)
        return None

    def _materialize_one(
        self, hub_path: str, content: str
    ) -> Optional[str]:
        mount_path = self._to_mount_path(hub_path)
        responses = self._inner.upload_files(
            [(mount_path, content.encode("utf-8"))]
        )
        if not responses:
            return self._on_materialize_after_commit_failure(
                hub_path, "no response from inner sandbox"
            )
        resp = responses[0]
        if resp.error is not None:
            return self._on_materialize_after_commit_failure(
                hub_path, str(resp.error)
            )
        return None

    def _on_materialize_after_commit_failure(
        self, hub_path: str, detail: str
    ) -> str:
        """Mark cache stale and build a divergence error message.

        The hub already accepted the commit, so cache + hub claim the
        new content but the sandbox does not. Subsequent reads from the
        cache would lie to the agent. Mark stale so the caller can call
        ``refresh()`` (or re-enter) and log loudly.
        """
        self._cache_stale = True
        logger.error(
            "hub/sandbox divergence on %s (hub commit %s succeeded but inner "
            "materialization failed: %s)",
            hub_path, self._commit_hash, detail,
        )
        return (
            f"hub/sandbox diverge: hub commit succeeded but inner "
            f"materialization failed ({detail}). Cache is stale; "
            f"call refresh() or re-enter the backend."
        )

    def _push_to_hub(
        self,
        files: Mapping[str, Optional[str]],
    ) -> Optional[str]:
        """Push files to the hub, updating ``_commit_hash`` on success.

        Raises :class:`HubConflictError` (after marking the cache stale)
        or :class:`HubError` on transport / server failure. The cache
        and inner sandbox are not touched here — callers decide what
        to do with their state on either side of the call.
        """
        push_fn = (
            self._hub.push_agent
            if self._repo_type == "agent"
            else self._hub.push_skill
        )
        payload: Dict[str, Optional[Entry]] = {
            path: (None if content is None else FileEntry(content=content))
            for path, content in files.items()
        }
        try:
            commit_url_or_ref = push_fn(
                self._identifier,
                files=payload,
                parent_commit=self._commit_hash,
            )
        except HubConflictError:
            self._cache_stale = True
            raise
        except HubError:
            raise
        except Exception as e:
            logger.exception(
                "hub push failed for %s (transport/unknown error)",
                self._identifier,
            )
            raise HubError(f"{type(e).__name__}: {e}") from e
        new_hash = _extract_commit_hash(commit_url_or_ref)
        if new_hash is None:
            logger.warning(
                "could not extract commit hash from push response %r; "
                "subsequent pushes will use stale parent_commit %r",
                commit_url_or_ref, self._commit_hash,
            )
        else:
            self._commit_hash = new_hash
        return new_hash

    def _push_files(
        self,
        files: Mapping[str, Optional[str]],
    ) -> Optional[str]:
        """``_push_to_hub`` adapter that returns ``None`` on success and
        a human-readable error message on failure.

        Used by single-operation paths (``write``/``edit``) where the
        caller wants a structured Result rather than an exception.
        ``None`` values in ``files`` mark a deletion.
        """
        try:
            self._push_to_hub(files)
        except HubConflictError as e:
            return f"hub conflict: {e}"
        except HubError as e:
            return f"hub push failed: {e}"
        return None

    def flush(self) -> Optional[str]:
        """Push buffered changes to the hub.

        Returns the new commit hash on success, or ``None`` when there
        was nothing to flush. Raises :class:`HubConflictError` or
        :class:`HubError` on failure — the dirty buffer is preserved so
        the caller can retry after a refresh.
        """
        if not self._dirty_files:
            return None
        batch = dict(self._dirty_files)
        new_hash = self._push_to_hub(batch)
        # Only clear on success; ``_push_to_hub`` raised on any failure,
        # so reaching here means the hub accepted the batch.
        self._dirty_files = {}
        return new_hash


# Local glob matcher so this module doesn't pull `backend.py`'s SDK
# dependency tree just for `_compile_glob`.


def _translate_glob_segment(segment: str) -> str:
    out: List[str] = []
    i = 0
    while i < len(segment):
        c = segment[i]
        if c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            end = segment.find("]", i + 1)
            if end == -1:
                out.append(re.escape(c))
                i += 1
            else:
                out.append(segment[i : end + 1])
                i = end + 1
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)


def _compile_glob(pattern: str):
    if "/" not in pattern:
        segment_regex = _translate_glob_segment(pattern)
        compiled_basename = re.compile("^" + segment_regex + "$")
        return lambda path: (
            compiled_basename.fullmatch(posixpath.basename(path)) is not None
        )
    segments = pattern.split("/")
    collapsed: List[str] = []
    for seg in segments:
        if seg == "**" and collapsed and collapsed[-1] == "**":
            continue
        collapsed.append(seg)
    segments = collapsed
    if len(segments) == 1 and segments[0] == "**":
        return lambda path: True
    regex_parts: List[str] = []
    for i, seg in enumerate(segments):
        is_first = i == 0
        is_last = i == len(segments) - 1
        if seg == "**":
            if is_first:
                regex_parts.append("(?:[^/]+/)*")
            elif is_last:
                regex_parts.append("/.*")
            else:
                regex_parts.append("/(?:[^/]+/)*")
            continue
        if not is_first:
            prev = segments[i - 1]
            if prev != "**":
                regex_parts.append("/")
        regex_parts.append(_translate_glob_segment(seg))
    compiled = re.compile("^" + "".join(regex_parts) + "$")
    return lambda path: compiled.fullmatch(path) is not None


def create_context_hub_synced_backend_factory(
    *,
    inner_factory: "Callable[[Any], SandboxBackendProtocol]",
    hub_client: ContextHubClientProtocol,
    identifier: str,
    mount_prefix: str = "/context",
    **wrapper_kwargs: Any,
) -> "Callable[[Any], ContextHubSyncedSandboxBackend]":
    """Eagerly-entered ``create_deep_agent(backend=...)`` factory.

    Registers a :func:`weakref.finalize` cleanup so the wrapper is
    released on GC / interpreter shutdown — required because
    ``create_deep_agent`` uses the factory result directly without a
    ``with`` block.
    """

    def factory(runtime: Any) -> ContextHubSyncedSandboxBackend:
        inner = inner_factory(runtime)
        backend = ContextHubSyncedSandboxBackend(
            inner=inner,
            hub_client=hub_client,
            identifier=identifier,
            mount_prefix=mount_prefix,
            **wrapper_kwargs,
        )
        backend.__enter__()

        def _cleanup(b: ContextHubSyncedSandboxBackend) -> None:
            try:
                b.__exit__(None, None, None)
            except Exception as e:  # pragma: no cover - best effort
                logger.warning("synced backend cleanup raised: %s", e)

        backend._finalizer = weakref.finalize(
            backend, _cleanup, backend
        )
        return backend

    return factory


def _extract_commit_hash(value: object) -> Optional[str]:
    """Extract a commit hash from a hub push return value.

    Accepts either a bare commit hash, a ``commit-<hash>`` style id, or
    a URL with ``:<hash>`` suffix.
    """
    if not isinstance(value, str):
        return None
    if ":" in value:
        candidate = value.rsplit(":", 1)[-1]
    elif value.startswith("commit-"):
        candidate = value[len("commit-"):]
    else:
        candidate = value
    if re.fullmatch(r"[0-9a-f]{8,64}", candidate):
        return candidate
    return None


__all__ = [
    "ContextHubSyncedSandboxBackend",
    "create_context_hub_synced_backend_factory",
]

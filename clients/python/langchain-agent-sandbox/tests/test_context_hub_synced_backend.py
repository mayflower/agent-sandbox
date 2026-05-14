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

from __future__ import annotations

import pytest

from langchain_agent_sandbox import ContextHubSyncedSandboxBackend
from langchain_agent_sandbox.context_hub_client import HubConflictError, HubError
from langchain_agent_sandbox.context_hub_models import (
    AgentEntry,
    FileEntry,
    SkillEntry,
)

from tests.fake_context_hub import FakeContextHubClient
from tests.fake_sandbox_backend import FakeSandboxBackend


# ---------------------------------------------------------------------------
# Test factory
# ---------------------------------------------------------------------------


def make_backend(
    *,
    commit_mode: str = "per_operation",
    context_write_mode: str = "context_hub",
    repo_type: str = "agent",
    seed: bool = True,
    mount_prefix: str = "/context",
    identifier: str = "team/agent",
):
    hub = FakeContextHubClient()
    if seed:
        if repo_type == "agent":
            hub.seed_agent(
                identifier,
                {
                    "AGENTS.md": FileEntry(content="You are helpful\nTODO: improve"),
                    "memories/a.md": FileEntry(content="alpha\nbeta\nalpha"),
                    "skills/research": SkillEntry(repo_handle="research"),
                    "agents/scheduler": AgentEntry(repo_handle="scheduler"),
                },
                commit_hash="aaaaaaaa",
            )
        else:
            hub.seed_skill(
                identifier,
                {
                    "SKILL.md": FileEntry(content="skill body\nTODO: refine"),
                    "memories/n.md": FileEntry(content="one\ntwo"),
                },
                commit_hash="aaaaaaaa",
            )
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier=identifier,
        repo_type=repo_type,  # type: ignore[arg-type]
        mount_prefix=mount_prefix,
        commit_mode=commit_mode,  # type: ignore[arg-type]
        context_write_mode=context_write_mode,  # type: ignore[arg-type]
    )
    return backend, inner, hub


# ---------------------------------------------------------------------------
# Hydration
# ---------------------------------------------------------------------------


def test_enter_calls_inner_enter_then_pulls_then_materializes():
    backend, inner, hub = make_backend()
    with backend:
        assert inner.entered is True
        assert hub.pull_calls and hub.pull_calls[-1]["repo_type"] == "agent"
        assert inner.files["/context/AGENTS.md"].startswith(b"You are helpful")
        assert inner.files["/context/memories/a.md"] == b"alpha\nbeta\nalpha"
    assert inner.exited is True


def test_enter_does_not_materialize_linked_entries():
    backend, inner, hub = make_backend()
    with backend:
        assert "/context/skills/research" not in inner.files
        assert "/context/agents/scheduler" not in inner.files


def test_get_linked_entries_returns_defensive_copy():
    backend, inner, hub = make_backend()
    with backend:
        links = backend.get_linked_entries()
        assert isinstance(links, dict)
        assert "skills/research" in links
        assert "agents/scheduler" in links
        links["skills/research"] = "tampered"  # type: ignore[assignment]
        assert backend.get_linked_entries()["skills/research"].type == "skill"


def test_has_prior_commits_reflects_commit_hash():
    backend, inner, hub = make_backend()
    with backend:
        assert backend.has_prior_commits() is True


def test_missing_repo_treated_as_empty():
    backend, inner, hub = make_backend(seed=False, identifier="team/brand-new")
    with backend:
        assert backend.has_prior_commits() is False
        result = backend.ls("/context")
        assert result.error is None
        assert result.entries == []


@pytest.mark.parametrize(
    "error_factory",
    [
        lambda: HubError("hub offline"),
        lambda: HubConflictError("conflict"),
    ],
)
def test_hydration_pull_error_releases_inner_backend(error_factory):
    """Non-NotFound hub errors during the pull must still release the
    inner backend — otherwise a managed sandbox leaks every time the
    hub is down/auth'd-out."""
    hub = FakeContextHubClient()
    hub.seed_agent("team/agent", {"AGENTS.md": FileEntry(content="hi")})
    hub.fail_next_pull = error_factory()
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent",
    )
    with pytest.raises(HubError):
        backend.__enter__()
    assert inner.exited is True


def test_materialization_failure_calls_inner_exit_and_reraises():
    backend, inner, hub = make_backend()
    inner.fail_upload = True
    with pytest.raises(HubError):
        backend.__enter__()
    assert inner.exited is True


def test_execute_delegates_to_inner():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.execute("cat /context/AGENTS.md")
    assert result.exit_code == 0
    assert "You are helpful" in result.output
    assert inner.execute_calls == [("cat /context/AGENTS.md", None)]


def test_execute_propagates_timeout_argument():
    backend, inner, hub = make_backend()
    with backend:
        backend.execute("noop", timeout=12)
    assert inner.execute_calls[-1] == ("noop", 12)


def test_id_contains_inner_id_and_identifier_and_version():
    backend, inner, hub = make_backend()
    with backend:
        ident = backend.id
    assert "team/agent" in ident
    assert "fake-sandbox" in ident


def test_skill_repo_type_uses_pull_skill():
    backend, inner, hub = make_backend(repo_type="skill", identifier="team/skill")
    with backend:
        assert any(c["repo_type"] == "skill" for c in hub.pull_calls)
        assert inner.files["/context/SKILL.md"].startswith(b"skill body")


def test_explicit_version_passed_to_pull():
    hub = FakeContextHubClient()
    hub.seed_agent("team/agent", {"AGENTS.md": FileEntry(content="hi")})
    head = hub.pull_agent("team/agent").commit_hash
    assert head is not None
    hub.promote("team/agent", "production", head, repo_type="agent")
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/agent",
        mount_prefix="/context",
        version="production",
    )
    with backend:
        pass
    assert hub.pull_calls[-1]["version"] == "production"


def test_inline_version_used_when_no_kwarg_passed():
    hub = FakeContextHubClient()
    hub.seed_agent("team/agent", {"AGENTS.md": FileEntry(content="hi")})
    head = hub.pull_agent("team/agent").commit_hash
    assert head is not None
    hub.promote("team/agent", "production", head, repo_type="agent")
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/agent:production",
        mount_prefix="/context",
    )
    with backend:
        # Inline version winds up on the identifier we pass to the hub,
        # so the pull resolves the production tag even without an explicit
        # kwarg.
        assert hub.pull_calls[-1]["identifier"].endswith(":production")


def test_aenter_aexit_delegates():
    import asyncio

    backend, inner, hub = make_backend()

    async def run():
        async with backend:
            assert inner.entered is True
        assert inner.exited is True

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def test_read_context_uses_cache():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.read("/context/AGENTS.md")
    assert result.error is None
    assert "You are helpful" in result.file_data["content"]


def test_read_context_respects_offset_and_limit():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.read("/context/memories/a.md", offset=1, limit=1)
    assert result.error is None
    assert result.file_data["content"] == "beta"


def test_read_non_context_delegates_to_inner():
    backend, inner, hub = make_backend()
    inner.files["/workspace/x.txt"] = b"hello inner"
    with backend:
        result = backend.read("/workspace/x.txt")
    assert result.error is None
    assert result.file_data["content"] == "hello inner"


def test_read_missing_context_file_returns_error_no_exception():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.read("/context/nope.md")
    assert result.file_data is None
    assert "not found" in (result.error or "").lower()


# ---------------------------------------------------------------------------
# LS
# ---------------------------------------------------------------------------


def test_ls_context_lists_immediate_entries():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.ls("/context")
    assert result.error is None
    paths = sorted(e["path"] for e in result.entries)
    # Linked entries surface as directories at the mount root (skills/, agents/).
    assert "/context/AGENTS.md" in paths
    assert "/context/memories" in paths
    assert "/context/skills" in paths
    assert "/context/agents" in paths


def test_ls_context_subdirectory_lists_children_only():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.ls("/context/memories")
    paths = sorted(e["path"] for e in result.entries)
    assert paths == ["/context/memories/a.md"]


def test_ls_non_context_delegates():
    backend, inner, hub = make_backend()
    inner.files["/workspace/x.txt"] = b"x"
    with backend:
        result = backend.ls("/workspace")
    paths = [e["path"] for e in result.entries]
    assert "/workspace/x.txt" in paths


# ---------------------------------------------------------------------------
# Glob
# ---------------------------------------------------------------------------


def test_glob_context_basename_pattern_matches_at_any_depth():
    """Bare pattern (no slash) matches against basename only — same as
    ``AgentSandboxBackend.glob`` and ``pathlib.PurePath.match``."""
    backend, inner, hub = make_backend()
    with backend:
        result = backend.glob("*.md", path="/context")
    assert result.error is None
    paths = sorted(m["path"] for m in result.matches)
    assert paths == ["/context/AGENTS.md", "/context/memories/a.md"]


def test_glob_context_recursive_md():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.glob("**/*.md", path="/context")
    paths = sorted(m["path"] for m in result.matches)
    assert paths == ["/context/AGENTS.md", "/context/memories/a.md"]


def test_glob_context_specific_subdir_pattern():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.glob("memories/*.md", path="/context")
    paths = sorted(m["path"] for m in result.matches)
    assert paths == ["/context/memories/a.md"]


def test_glob_non_context_delegates():
    backend, inner, hub = make_backend()
    inner.files["/workspace/a.py"] = b"x"
    with backend:
        result = backend.glob("*.py", path="/workspace")
    paths = [m["path"] for m in result.matches]
    assert "/workspace/a.py" in paths


# ---------------------------------------------------------------------------
# Grep
# ---------------------------------------------------------------------------


def test_grep_context_literal_with_line_numbers():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.grep("TODO", path="/context")
    assert result.error is None
    assert result.matches == [
        {
            "path": "/context/AGENTS.md",
            "line": 2,
            "text": "TODO: improve",
        }
    ]


def test_grep_context_glob_filters_files():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.grep(
            "alpha", path="/context", glob="memories/**"
        )
    paths = [m["path"] for m in result.matches]
    assert paths == ["/context/memories/a.md", "/context/memories/a.md"]


def test_grep_non_context_delegates():
    backend, inner, hub = make_backend()
    inner.files["/workspace/notes.txt"] = b"keep\nthrow"
    with backend:
        result = backend.grep("keep", path="/workspace")
    paths = [m["path"] for m in result.matches]
    assert paths == ["/workspace/notes.txt"]


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------


def test_download_context_returns_utf8_bytes():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.download_files(["/context/AGENTS.md"])
    assert len(result) == 1
    assert result[0].error is None
    assert result[0].content == b"You are helpful\nTODO: improve"


def test_download_missing_context_file_returns_file_not_found():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.download_files(["/context/missing.md"])
    assert result[0].error == "file_not_found"


def test_download_mixed_paths_preserves_order():
    backend, inner, hub = make_backend()
    inner.files["/workspace/x.txt"] = b"workspace"
    with backend:
        result = backend.download_files(
            ["/workspace/x.txt", "/context/AGENTS.md", "/context/missing.md"]
        )
    assert [r.path for r in result] == [
        "/workspace/x.txt",
        "/context/AGENTS.md",
        "/context/missing.md",
    ]
    assert result[0].content == b"workspace"
    assert result[1].content == b"You are helpful\nTODO: improve"
    assert result[2].error == "file_not_found"


# ---------------------------------------------------------------------------
# Result objects are agent-friendly
# ---------------------------------------------------------------------------


def test_ls_returns_empty_list_when_no_error():
    backend, inner, hub = make_backend(seed=False, identifier="team/empty")
    with backend:
        result = backend.ls("/context")
    assert result.error is None
    assert result.entries == []


def test_glob_returns_empty_matches_on_no_hits():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.glob("*.rs", path="/context")
    assert result.error is None
    assert result.matches == []


def test_grep_returns_empty_matches_on_no_hits():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.grep("ZZZZZ", path="/context")
    assert result.error is None
    assert result.matches == []


# ---------------------------------------------------------------------------
# P04: write / hub-first commits
# ---------------------------------------------------------------------------


def test_write_context_is_hub_first_then_materializes():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.write("/context/new.md", "new content")
    assert result.error is None
    assert hub.push_calls[-1]["parent_commit"] == "aaaaaaaa"
    assert "new.md" in hub.push_calls[-1]["files"]
    pushed = hub.push_calls[-1]["files"]["new.md"]
    assert pushed.content == "new content"
    assert inner.files["/context/new.md"] == b"new content"


def test_write_updates_commit_hash_on_success():
    backend, inner, hub = make_backend()
    with backend:
        backend.write("/context/new.md", "first")
        h1 = hub.push_calls[-1]["commit_hash"]
        backend.write("/context/again.md", "second")
        h2 = hub.push_calls[-1]["commit_hash"]
    assert h1 != h2
    # Second push chained off the first, so its parent_commit is h1.
    assert hub.push_calls[-1]["parent_commit"] == h1


def test_write_context_hub_failure_does_not_modify_sandbox():
    backend, inner, hub = make_backend()
    hub.fail_next_push = HubError("hub offline")
    with backend:
        result = backend.write("/context/new.md", "new content")
    assert result.error is not None
    assert "/context/new.md" not in inner.files


def test_write_context_hub_conflict_returns_error_and_keeps_sandbox():
    backend, inner, hub = make_backend()
    hub.fail_next_push = HubConflictError("parent_commit drift")
    with backend:
        result = backend.write("/context/new.md", "new content")
    assert result.error is not None
    assert "conflict" in (result.error or "").lower()
    assert "/context/new.md" not in inner.files


def test_write_context_default_mode_is_upsert():
    backend, inner, hub = make_backend()
    with backend:
        # AGENTS.md exists in seed; upsert should succeed under
        # context_write_mode="context_hub" (default).
        result = backend.write("/context/AGENTS.md", "replacement")
    assert result.error is None
    assert inner.files["/context/AGENTS.md"] == b"replacement"


def test_write_context_deepagents_mode_rejects_existing_file():
    backend, inner, hub = make_backend(context_write_mode="deepagents")
    with backend:
        result = backend.write("/context/AGENTS.md", "replacement")
    assert result.error is not None
    assert len(hub.push_calls) == 0


def test_write_non_context_delegates_to_inner():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.write("/workspace/x.txt", "x")
    assert result.error is None
    assert inner.files["/workspace/x.txt"] == b"x"
    assert len(hub.push_calls) == 0


def test_write_context_invalid_path_returns_error_no_push():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.write("/context/../escape.md", "x")
    assert result.error is not None
    assert len(hub.push_calls) == 0


# ---------------------------------------------------------------------------
# P04: edit
# ---------------------------------------------------------------------------


def test_edit_context_commits_and_counts_occurrences():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.edit(
            "/context/memories/a.md", "alpha", "gamma", replace_all=True
        )
    assert result.error is None
    assert result.occurrences == 2
    entry = hub.push_calls[-1]["files"]["memories/a.md"]
    assert entry.content == "gamma\nbeta\ngamma"
    assert inner.files["/context/memories/a.md"] == b"gamma\nbeta\ngamma"


def test_edit_context_single_replace_replaces_one_occurrence():
    backend, inner, hub = make_backend()
    with backend:
        result = backend.edit(
            "/context/memories/a.md", "beta", "BETA", replace_all=False
        )
    assert result.error is None
    assert result.occurrences == 1
    assert inner.files["/context/memories/a.md"] == b"alpha\nBETA\nalpha"


def test_edit_context_multiple_without_replace_all_fails_no_push():
    backend, inner, hub = make_backend()
    before = len(hub.push_calls)
    with backend:
        result = backend.edit(
            "/context/memories/a.md", "alpha", "gamma", replace_all=False
        )
    assert result.error is not None
    assert result.occurrences == 2
    assert len(hub.push_calls) == before


def test_edit_context_no_match_no_push():
    backend, inner, hub = make_backend()
    before = len(hub.push_calls)
    with backend:
        result = backend.edit(
            "/context/AGENTS.md", "NOPE", "X", replace_all=False
        )
    assert result.error is not None
    assert result.occurrences == 0
    assert len(hub.push_calls) == before


def test_edit_context_hub_conflict_keeps_sandbox():
    backend, inner, hub = make_backend()
    with backend:
        original = inner.files["/context/memories/a.md"]
        hub.fail_next_push = HubConflictError("conflict")
        result = backend.edit(
            "/context/memories/a.md", "alpha", "gamma", replace_all=True
        )
        assert inner.files["/context/memories/a.md"] == original
    assert result.error is not None
    assert "conflict" in (result.error or "").lower()


# ---------------------------------------------------------------------------
# P04: upload_files
# ---------------------------------------------------------------------------


def test_upload_context_only_batch_makes_single_commit():
    backend, inner, hub = make_backend()
    with backend:
        responses = backend.upload_files(
            [
                ("/context/one.md", b"one"),
                ("/context/two.md", b"two"),
            ]
        )
    assert [r.error for r in responses] == [None, None]
    assert len(hub.push_calls) == 1
    files = hub.push_calls[0]["files"]
    assert "one.md" in files and "two.md" in files
    assert inner.files["/context/one.md"] == b"one"
    assert inner.files["/context/two.md"] == b"two"


def test_upload_context_batch_rejects_non_utf8_but_commits_valid():
    backend, inner, hub = make_backend()
    with backend:
        responses = backend.upload_files(
            [
                ("/context/ok.md", b"ok"),
                ("/context/bad.bin", b"\xff"),
            ]
        )
    assert responses[0].error is None
    assert responses[1].error == "not_utf8"
    assert len(hub.push_calls) == 1
    assert "ok.md" in hub.push_calls[0]["files"]
    assert "bad.bin" not in hub.push_calls[0]["files"]
    assert "/context/ok.md" in inner.files
    assert "/context/bad.bin" not in inner.files


def test_upload_mixed_paths_preserve_order_with_one_hub_commit():
    backend, inner, hub = make_backend()
    with backend:
        responses = backend.upload_files(
            [
                ("/workspace/x.txt", b"x"),
                ("/context/y.md", b"y"),
                ("/workspace/z.txt", b"z"),
            ]
        )
    assert [r.path for r in responses] == [
        "/workspace/x.txt",
        "/context/y.md",
        "/workspace/z.txt",
    ]
    assert [r.error for r in responses] == [None, None, None]
    assert inner.files["/context/y.md"] == b"y"
    assert inner.files["/workspace/x.txt"] == b"x"
    assert inner.files["/workspace/z.txt"] == b"z"
    assert len(hub.push_calls) == 1


def test_upload_context_hub_failure_marks_only_context_paths_failed():
    backend, inner, hub = make_backend()
    hub.fail_next_push = HubError("hub offline")
    with backend:
        responses = backend.upload_files(
            [
                ("/workspace/x.txt", b"x"),
                ("/context/y.md", b"y"),
            ]
        )
    # Inner files still got written (they were always pre-hub-failure
    # because they bypass the hub).
    assert inner.files["/workspace/x.txt"] == b"x"
    # Context-bound entry must be marked failed and not materialized.
    by_path = {r.path: r for r in responses}
    assert by_path["/workspace/x.txt"].error is None
    assert by_path["/context/y.md"].error is not None
    assert "/context/y.md" not in inner.files


def test_upload_context_duplicate_paths_last_write_wins_in_commit():
    backend, inner, hub = make_backend()
    with backend:
        responses = backend.upload_files(
            [
                ("/context/dup.md", b"first"),
                ("/context/dup.md", b"second"),
            ]
        )
    assert [r.error for r in responses] == [None, None]
    assert hub.push_calls[-1]["files"]["dup.md"].content == "second"
    assert inner.files["/context/dup.md"] == b"second"


# ---------------------------------------------------------------------------
# P04: commit modes
# ---------------------------------------------------------------------------


def test_per_operation_pushes_one_commit_per_write():
    backend, inner, hub = make_backend()
    with backend:
        backend.write("/context/one.md", "one")
        backend.write("/context/two.md", "two")
    assert len(hub.push_calls) == 2


def test_on_exit_buffers_until_close():
    backend, inner, hub = make_backend(commit_mode="on_exit")
    with backend:
        r1 = backend.write("/context/one.md", "one")
        r2 = backend.write("/context/two.md", "two")
        assert r1.error is None and r2.error is None
        assert len(hub.push_calls) == 0
        # In-session reads must still see the new content even though
        # the hub hasn't been written yet.
        read = backend.read("/context/one.md")
        assert read.file_data["content"] == "one"
        # Sandbox materialization happens immediately for read-your-writes.
        assert inner.files["/context/one.md"] == b"one"
    assert len(hub.push_calls) == 1
    assert set(hub.push_calls[0]["files"]) == {"one.md", "two.md"}


def test_manual_only_flushes_on_explicit_call():
    backend, inner, hub = make_backend(commit_mode="manual")
    with backend:
        backend.write("/context/one.md", "one")
        assert len(hub.push_calls) == 0
        backend.flush()
        assert len(hub.push_calls) == 1
        backend.flush()
        assert len(hub.push_calls) == 1  # idempotent


def test_pending_changes_reports_dirty_paths():
    backend, inner, hub = make_backend(commit_mode="manual")
    with backend:
        assert backend.pending_changes() == ()
        backend.write("/context/one.md", "one")
        backend.write("/context/two.md", "two")
        pending = backend.pending_changes()
        assert set(pending) == {"one.md", "two.md"}


def test_on_exit_attempts_flush_even_on_body_exception():
    """If the agent crashes mid-session under on_exit, buffered hub
    changes still need to reach the server — otherwise the agent's
    work is silently dropped on the way out."""
    backend, inner, hub = make_backend(commit_mode="on_exit")
    try:
        with backend:
            backend.write("/context/work.md", "in-progress")
            raise RuntimeError("agent crashed")
    except RuntimeError:
        pass
    assert hub.push_calls
    assert "work.md" in hub.push_calls[-1]["files"]


def test_on_exit_flush_failure_during_body_exception_is_logged(caplog):
    """When both the body raises and flush fails, the body exception
    wins (Python semantics) but the flush failure must be visible."""
    import logging

    backend, inner, hub = make_backend(commit_mode="on_exit")
    with caplog.at_level(logging.ERROR, logger="langchain_agent_sandbox.context_hub_sync"):
        try:
            with backend:
                backend.write("/context/work.md", "x")
                hub.fail_next_push = HubError("hub offline")
                raise RuntimeError("agent crashed")
        except RuntimeError:
            pass
    assert any(
        "flush" in rec.getMessage().lower() or "hub" in rec.getMessage().lower()
        for rec in caplog.records
    )


def test_on_exit_flush_failure_propagates():
    backend, inner, hub = make_backend(commit_mode="on_exit")
    with pytest.raises(HubError):
        with backend:
            backend.write("/context/one.md", "one")
            hub.fail_next_push = HubError("hub offline")


# ---------------------------------------------------------------------------
# Hub-first invariant after a successful commit
# ---------------------------------------------------------------------------


def _install_post_enter_upload_failure(inner: FakeSandboxBackend) -> None:
    """Have ``inner.upload_files`` fail every call after this point.

    Hydration runs through ``upload_files`` too, so the failure has to
    be installed *after* the wrapper finishes ``__enter__`` — otherwise
    the materialization-after-commit path under test never executes.
    """
    from deepagents.backends.protocol import FileUploadResponse

    def fail(files):
        return [
            FileUploadResponse(path=p, error="upload_failed")  # type: ignore[arg-type]
            for p, _ in files
        ]

    inner.upload_files = fail  # type: ignore[assignment]


def test_write_materialize_failure_after_hub_commit_marks_cache_stale():
    backend, inner, hub = make_backend()
    with backend:
        _install_post_enter_upload_failure(inner)
        result = backend.write("/context/new.md", "x")
    assert hub.push_calls, "expected hub push to have occurred"
    assert result.error is not None
    assert (
        "diverge" in (result.error or "").lower()
        or "stale" in (result.error or "").lower()
    )
    assert backend._cache_stale is True


def test_edit_materialize_failure_after_hub_commit_marks_cache_stale():
    backend, inner, hub = make_backend()
    with backend:
        _install_post_enter_upload_failure(inner)
        result = backend.edit(
            "/context/memories/a.md", "beta", "BETA", replace_all=False
        )
    assert result.error is not None
    assert backend._cache_stale is True


def test_upload_materialize_failure_after_hub_commit_marks_cache_stale():
    backend, inner, hub = make_backend()
    with backend:
        _install_post_enter_upload_failure(inner)
        responses = backend.upload_files([("/context/new.md", b"x")])
    assert responses[0].error is not None
    assert backend._cache_stale is True


def test_flush_conflict_marks_cache_stale():
    """A conflict during flush must set the same stale flag that
    `_push_files` sets in `per_operation`. Asymmetry would leave
    on_exit/manual users without the stale signal."""
    backend, inner, hub = make_backend(commit_mode="manual")
    with backend:
        backend.write("/context/one.md", "one")
        hub.fail_next_push = HubConflictError("conflict")
        with pytest.raises(HubConflictError):
            backend.flush()
        assert backend._cache_stale is True
        # Dirty buffer is preserved so the caller can retry after a refresh.
        assert "one.md" in backend._dirty_files


# ---------------------------------------------------------------------------
# Mount escape via .. on read-side ops
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "escape_path",
    [
        "/context/../escape.md",
        "/context/sub/../../escape.md",
        "/context/./..",
        "/context/.././secret",
    ],
)
def test_read_refuses_traversal_outside_mount(escape_path):
    """`read` must not silently delegate to inner when the caller
    addresses the mount but the path normalises out of it."""
    backend, inner, hub = make_backend()
    inner.files["/escape.md"] = b"TOP SECRET"
    inner.files["/secret"] = b"shh"
    with backend:
        result = backend.read(escape_path)
    assert result.error is not None
    assert "escape" in (result.error or "").lower() or "mount" in (result.error or "").lower()


def test_ls_refuses_traversal_outside_mount():
    backend, inner, hub = make_backend()
    inner.files["/outside.md"] = b"x"
    with backend:
        result = backend.ls("/context/..")
    assert result.error is not None
    assert result.entries == []


def test_grep_refuses_traversal_outside_mount():
    backend, inner, hub = make_backend()
    inner.files["/secret.md"] = b"TOP SECRET"
    with backend:
        result = backend.grep("SECRET", path="/context/..")
    assert result.error is not None
    assert result.matches == []


def test_glob_refuses_traversal_outside_mount():
    backend, inner, hub = make_backend()
    inner.files["/escape.md"] = b"x"
    with backend:
        result = backend.glob("**/*.md", path="/context/..")
    assert result.error is not None
    assert result.matches == []


def test_download_files_refuses_traversal_outside_mount():
    backend, inner, hub = make_backend()
    inner.files["/escape.md"] = b"x"
    with backend:
        result = backend.download_files(["/context/../escape.md"])
    assert len(result) == 1
    assert result[0].error == "invalid_path"
    assert result[0].content is None


def test_flush_preserves_dirty_buffer_on_transient_failure():
    """Retry-after-flush-failure is the documented contract — the
    buffered batch must survive a failed push so a follow-up flush
    can re-attempt the same commit."""
    backend, inner, hub = make_backend(commit_mode="manual")
    with backend:
        backend.write("/context/one.md", "one")
        hub.fail_next_push = HubError("transient")
        with pytest.raises(HubError):
            backend.flush()
        assert "one.md" in backend._dirty_files
        # Successful retry pushes the same payload and clears the buffer.
        backend.flush()
        assert backend._dirty_files == {}
        assert hub.push_calls[-1]["files"]["one.md"].content == "one"


# ---------------------------------------------------------------------------
# P04: tags / linked entries
# ---------------------------------------------------------------------------


def test_write_does_not_delete_linked_entries():
    backend, inner, hub = make_backend()
    with backend:
        before_links = backend.get_linked_entries()
        backend.write("/context/new.md", "x")
        after_links = backend.get_linked_entries()
    assert before_links == after_links
    # Push sent only the file change, not None deletions for links.
    sent = hub.push_calls[-1]["files"]
    assert "skills/research" not in sent
    assert "agents/scheduler" not in sent
    assert "new.md" in sent


# ---------------------------------------------------------------------------
# Path exclusions under the context mount
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "excluded_path",
    [
        "/context/.env",
        "/context/.env.production",
        "/context/.git/config",
        "/context/.git/HEAD",
        "/context/.hg/store",
        "/context/.svn/wc.db",
        "/context/node_modules/react/package.json",
        "/context/__pycache__/foo.cpython-312.pyc",
        "/context/.venv/lib/python/something",
        "/context/dist/wheel.whl",
        "/context/build/lib/foo.py",
    ],
)
def test_write_rejects_excluded_paths_under_mount(excluded_path):
    backend, inner, hub = make_backend()
    before = len(hub.push_calls)
    with backend:
        result = backend.write(excluded_path, "x")
    assert result.error is not None
    assert "exclude" in (result.error or "").lower()
    assert len(hub.push_calls) == before
    assert excluded_path not in inner.files


def test_upload_files_rejects_excluded_paths_in_batch():
    backend, inner, hub = make_backend()
    with backend:
        responses = backend.upload_files(
            [
                ("/context/ok.md", b"ok"),
                ("/context/.env", b"SECRET=1"),
                ("/context/node_modules/x.js", b"x"),
            ]
        )
    by_path = {r.path: r for r in responses}
    assert by_path["/context/ok.md"].error is None
    # Distinct error codes per cause, not the generic invalid_path.
    assert by_path["/context/.env"].error == "excluded"
    assert by_path["/context/node_modules/x.js"].error == "excluded"
    # The successful upload still went to the hub as a single commit.
    files_in_push = hub.push_calls[-1]["files"]
    assert "ok.md" in files_in_push
    assert ".env" not in files_in_push
    assert "node_modules/x.js" not in files_in_push


def test_upload_distinct_error_codes_per_failure_class():
    backend, inner, hub = make_backend()
    backend._max_file_bytes = 50  # type: ignore[attr-defined]
    with backend:
        responses = backend.upload_files(
            [
                ("/context/.env", b"SECRET=1"),         # excluded
                ("/context/bad.bin", b"\xff"),           # non-utf-8
                ("/context/huge.md", b"x" * 100),        # oversize
                ("/context/../escape.md", b"x"),         # traversal
            ]
        )
    by_path = {r.path: r for r in responses}
    assert by_path["/context/.env"].error == "excluded"
    assert by_path["/context/bad.bin"].error == "not_utf8"
    assert by_path["/context/huge.md"].error == "too_large"
    assert by_path["/context/../escape.md"].error == "invalid_path"


def test_edit_rejects_excluded_paths():
    """Edit refuses excluded paths via the same deny-list as write —
    no need to seed the cache because the exclusion check runs before
    the cache lookup."""
    backend, inner, hub = make_backend()
    before = len(hub.push_calls)
    with backend:
        result = backend.edit("/context/.env", "OLD", "NEW", replace_all=True)
    assert result.error is not None
    assert "exclude" in (result.error or "").lower()
    assert len(hub.push_calls) == before


def test_exclusions_can_be_overridden_per_backend():
    """Operators can lift the defaults if they really want to track
    ``.env`` in their context hub (e.g. a tutorial repo)."""
    hub = FakeContextHubClient()
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/agent",
        mount_prefix="/context",
        excluded_globs=[],  # empty -> nothing is excluded
    )
    with backend:
        result = backend.write("/context/.env", "OK=1")
    assert result.error is None
    assert "/context/.env" in inner.files


def test_hydration_drops_excluded_paths(caplog):
    """A hub snapshot containing `.env` or `.git/...` must not be
    materialized into the sandbox. The wrapper drops them with a
    warning so operators can spot the divergence."""
    import logging

    hub = FakeContextHubClient()
    hub.seed_agent(
        "team/agent",
        {
            "AGENTS.md": FileEntry(content="hi"),
            ".env": FileEntry(content="SECRET=1"),
            ".git/config": FileEntry(content="git-stuff"),
            "node_modules/foo.js": FileEntry(content="js"),
        },
        commit_hash="aaaaaaaa",
    )
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent",
    )
    with caplog.at_level(logging.WARNING, logger="langchain_agent_sandbox.context_hub_sync"):
        with backend:
            assert "/context/AGENTS.md" in inner.files
            assert "/context/.env" not in inner.files
            assert "/context/.git/config" not in inner.files
            assert "/context/node_modules/foo.js" not in inner.files
            # Read also refuses to surface the excluded entry — the
            # cache should not carry it.
            assert backend.read("/context/.env").error is not None
    # At least one warning explaining the drop must have been emitted.
    assert any(
        ".env" in rec.getMessage() or "exclude" in rec.getMessage().lower()
        for rec in caplog.records
    )


def test_non_context_excluded_paths_pass_through():
    """Exclusions only apply under the context mount; non-mount paths
    are the inner backend's problem."""
    backend, inner, hub = make_backend()
    with backend:
        # `.env` outside the mount delegates straight to inner without
        # going through the exclusion check.
        result = backend.write("/workspace/.env", "OK=1")
    assert result.error is None
    assert inner.files["/workspace/.env"] == b"OK=1"


# ---------------------------------------------------------------------------
# materialize_linked
# ---------------------------------------------------------------------------


def test_materialize_linked_false_is_default():
    backend, inner, hub = make_backend()
    with backend:
        assert "/context/skills/research" not in inner.files
        assert "/context/agents/scheduler" not in inner.files


def test_materialize_linked_true_writes_pointer_files():
    hub = FakeContextHubClient()
    hub.seed_agent(
        "team/agent",
        {
            "AGENTS.md": FileEntry(content="hi"),
            "skills/research": SkillEntry(
                repo_handle="research",
                owner="team",
                commit_hash="abcdef12",
            ),
            "agents/scheduler": AgentEntry(repo_handle="scheduler"),
        },
        commit_hash="aaaaaaaa",
    )
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/agent",
        mount_prefix="/context",
        materialize_linked=True,
    )
    with backend:
        raw_skill = inner.files["/context/skills/research"]
        raw_agent = inner.files["/context/agents/scheduler"]
    import json as _json

    skill = _json.loads(raw_skill.decode("utf-8"))
    agent = _json.loads(raw_agent.decode("utf-8"))
    assert skill["type"] == "skill"
    assert skill["repo_handle"] == "research"
    assert skill["commit_hash"] == "abcdef12"
    assert agent["type"] == "agent"
    assert agent["repo_handle"] == "scheduler"


def test_materialize_linked_still_exposes_links_separately():
    hub = FakeContextHubClient()
    hub.seed_agent(
        "team/agent",
        {"skills/research": SkillEntry(repo_handle="research")},
        commit_hash="aaaaaaaa",
    )
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/agent",
        mount_prefix="/context",
        materialize_linked=True,
    )
    with backend:
        links = backend.get_linked_entries()
    assert "skills/research" in links


# ---------------------------------------------------------------------------
# Mixed-root aggregation
# ---------------------------------------------------------------------------


def test_ls_root_includes_mount_directory_and_inner_entries():
    backend, inner, hub = make_backend()
    inner.files["/workspace/a.txt"] = b"a"
    with backend:
        result = backend.ls("/")
    paths = sorted(e["path"] for e in result.entries)
    assert "/context" in paths
    assert "/workspace" in paths
    # The mount entry is marked as a directory.
    by_path = {e["path"]: e for e in result.entries}
    assert by_path["/context"]["is_dir"] is True


def test_ls_root_does_not_duplicate_mount_entry():
    backend, inner, hub = make_backend()
    # Even if the inner sandbox also reports /context (because hydration
    # materialized files into that directory), the wrapper must
    # de-duplicate.
    inner.files["/context/AGENTS.md"] = b"materialized"
    with backend:
        result = backend.ls("/")
    paths = [e["path"] for e in result.entries]
    assert paths.count("/context") == 1


def test_glob_root_aggregates_context_and_inner_without_duplicates():
    backend, inner, hub = make_backend()
    inner.files["/workspace/other.md"] = b"other"
    with backend:
        result = backend.glob("**/*.md", path="/")
    paths = sorted(m["path"] for m in result.matches)
    assert "/context/AGENTS.md" in paths
    assert "/context/memories/a.md" in paths
    assert "/workspace/other.md" in paths
    # Hydration also wrote AGENTS.md to inner; the mount path must not
    # appear twice.
    assert paths.count("/context/AGENTS.md") == 1


def test_grep_root_aggregates_context_and_inner():
    backend, inner, hub = make_backend()
    inner.files["/workspace/notes.txt"] = b"TODO outside\nplain"
    with backend:
        result = backend.grep("TODO", path="/")
    paths = sorted(m["path"] for m in result.matches)
    assert "/context/AGENTS.md" in paths
    assert "/workspace/notes.txt" in paths


# ---------------------------------------------------------------------------
# Snapshot size limits
# ---------------------------------------------------------------------------


def test_materialize_all_chunks_large_snapshots():
    """A 500-file snapshot must arrive at the inner backend as several
    batched upload_files calls, not one giant blob."""
    hub = FakeContextHubClient()
    big = {f"f{i:04d}.md": FileEntry(content=f"v{i}") for i in range(500)}
    hub.seed_agent("team/big", big)
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/big",
        max_files=10_000,
        materialize_chunk_size=128,
    )
    with backend:
        pass
    # All files materialized.
    assert sum(1 for p in inner.files if p.startswith("/context/")) == 500
    # And the chunking sent multiple upload batches rather than one.
    assert len(inner.upload_calls) >= 4
    for batch in inner.upload_calls:
        assert len(batch) <= 128


def test_hydration_rejects_oversized_snapshot_too_many_files():
    hub = FakeContextHubClient()
    big = {f"f{i}.md": FileEntry(content="x") for i in range(20)}
    hub.seed_agent("team/big", big)
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/big",
        mount_prefix="/context",
        max_files=10,
    )
    with pytest.raises(HubError):
        backend.__enter__()
    assert inner.exited is True


def test_hydration_rejects_oversized_snapshot_total_bytes():
    hub = FakeContextHubClient()
    hub.seed_agent(
        "team/big",
        {"big.md": FileEntry(content="x" * 1000)},
    )
    inner = FakeSandboxBackend()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner,
        hub_client=hub,
        identifier="team/big",
        mount_prefix="/context",
        max_total_bytes=100,
    )
    with pytest.raises(HubError):
        backend.__enter__()
    assert inner.exited is True


def test_write_rejects_oversized_single_file():
    backend, inner, hub = make_backend()
    backend._max_file_bytes = 50  # type: ignore[attr-defined]
    with backend:
        result = backend.write("/context/big.md", "x" * 100)
    assert result.error is not None
    assert "size" in (result.error or "").lower() or "limit" in (result.error or "").lower()


# ---------------------------------------------------------------------------
# Size-limit boundaries
# ---------------------------------------------------------------------------


def test_write_at_max_file_bytes_exactly_succeeds():
    backend, inner, hub = make_backend()
    backend._max_file_bytes = 100
    with backend:
        result = backend.write("/context/exact.md", "x" * 100)
    assert result.error is None


def test_write_one_byte_over_max_file_bytes_fails():
    backend, inner, hub = make_backend()
    backend._max_file_bytes = 100
    with backend:
        result = backend.write("/context/over.md", "x" * 101)
    assert result.error is not None


def test_upload_empty_list_returns_empty_without_calling_hub():
    backend, inner, hub = make_backend()
    push_count_before = len(hub.push_calls)
    with backend:
        responses = backend.upload_files([])
    assert responses == []
    assert len(hub.push_calls) == push_count_before


# ---------------------------------------------------------------------------
# _extract_commit_hash unit tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value, expected",
    [
        ("aaaaaaaa", "aaaaaaaa"),
        ("a" * 64, "a" * 64),
        ("https://hub.example.com/team/repo:aabbccdd", "aabbccdd"),
        ("commit-aabbccdd", "aabbccdd"),
        ("aaaaaaaa1234abcd", "aaaaaaaa1234abcd"),
    ],
)
def test_extract_commit_hash_accepts_valid_forms(value, expected):
    from langchain_agent_sandbox.context_hub_sync import _extract_commit_hash

    assert _extract_commit_hash(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "aaaaaaa",  # 7 chars — too short
        "A" * 8,    # uppercase
        "g" * 8,    # non-hex
        "a" * 65,   # too long
        "",
        None,
        123,
    ],
)
def test_extract_commit_hash_rejects_invalid(value):
    from langchain_agent_sandbox.context_hub_sync import _extract_commit_hash

    assert _extract_commit_hash(value) is None


def test_upload_rejects_oversized_file_in_batch():
    backend, inner, hub = make_backend()
    backend._max_file_bytes = 50  # type: ignore[attr-defined]
    with backend:
        responses = backend.upload_files(
            [
                ("/context/ok.md", b"ok"),
                ("/context/huge.md", b"x" * 100),
            ]
        )
    by_path = {r.path: r for r in responses}
    assert by_path["/context/ok.md"].error is None
    assert by_path["/context/huge.md"].error is not None

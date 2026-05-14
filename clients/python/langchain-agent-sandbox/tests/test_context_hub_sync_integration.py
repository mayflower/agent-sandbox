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

"""Integration tests for ContextHubSyncedSandboxBackend.

These tests use the in-memory fake hub + fake sandbox to exercise
behaviour that crosses class boundaries (policy wrapper composition,
session reattach, error-during-on_exit flushes).
"""

from __future__ import annotations

import pytest

from langchain_agent_sandbox import (
    ContextHubSyncedSandboxBackend,
    SandboxPolicyWrapper,
)
from langchain_agent_sandbox.context_hub_client import HubError
from langchain_agent_sandbox.context_hub_models import FileEntry

from tests.fake_context_hub import FakeContextHubClient
from tests.fake_sandbox_backend import FakeSandboxBackend


def _seeded_pair(identifier: str = "team/agent"):
    hub = FakeContextHubClient()
    hub.seed_agent(
        identifier,
        {"AGENTS.md": FileEntry(content="hi\nTODO: x")},
        commit_hash="aaaaaaaa",
    )
    return hub, FakeSandboxBackend()


# ---------------------------------------------------------------------------
# Read-after-hydrate
# ---------------------------------------------------------------------------


def test_execute_reads_hydrated_file_via_inner_shell():
    hub, inner = _seeded_pair()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    with backend:
        result = backend.execute("cat /context/AGENTS.md")
    assert result.exit_code == 0
    assert "hi" in result.output


def test_write_under_context_visible_to_shell_and_committed():
    hub, inner = _seeded_pair()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    with backend:
        write_result = backend.write("/context/new.md", "fresh")
        shell_result = backend.execute("cat /context/new.md")
    assert write_result.error is None
    assert "fresh" in shell_result.output
    pushed = hub.push_calls[-1]["files"]["new.md"]
    assert pushed.content == "fresh"


def test_write_outside_context_does_not_touch_hub():
    hub, inner = _seeded_pair()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    before = len(hub.push_calls)
    with backend:
        result = backend.write("/workspace/x.txt", "x")
    assert result.error is None
    assert len(hub.push_calls) == before
    assert inner.files["/workspace/x.txt"] == b"x"


# ---------------------------------------------------------------------------
# Policy wrapper composition
# ---------------------------------------------------------------------------


def test_policy_outside_blocks_context_writes():
    """When policy is *outside*, hub-bound writes are blocked at the
    wrapper before they reach the hub at all."""
    hub, inner = _seeded_pair()
    synced = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    # SandboxPolicyWrapper expects an AgentSandboxBackend nominally,
    # but only relies on the SandboxBackendProtocol interface.
    secured = SandboxPolicyWrapper(
        synced,  # type: ignore[arg-type]
        deny_prefixes=["/context"],
    )
    with secured:
        result = secured.write("/context/should-not.md", "x")
    assert result.error is not None
    assert "Policy denied" in (result.error or "")
    # Hub never saw the write attempt.
    assert all(
        "should-not.md" not in call["files"] for call in hub.push_calls
    )


def test_policy_inside_blocks_inner_materialization_only():
    """Policy *inside* runs at the inner-sandbox layer; the hub still
    receives the commit, but the inner materialization fails."""

    class DenyingInner(FakeSandboxBackend):
        def upload_files(self, files):
            # Refuse all writes; this mirrors what a real-world
            # SandboxPolicyWrapper would do when the path is denied.
            from deepagents.backends.protocol import FileUploadResponse

            return [
                FileUploadResponse(path=p, error="policy_denied")  # type: ignore[arg-type]
                for p, _ in files
            ]

    hub = FakeContextHubClient()
    hub.seed_agent("team/agent", {"AGENTS.md": FileEntry(content="hi")})
    inner = DenyingInner()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    with pytest.raises(HubError):
        backend.__enter__()
    # Even though materialization failed, the inner sandbox got
    # cleaned up so it doesn't leak.
    assert inner.exited is True


# ---------------------------------------------------------------------------
# Reattach hydration
# ---------------------------------------------------------------------------


def test_reattach_rehydrates_context_on_second_enter():
    hub, inner = _seeded_pair()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    with backend:
        backend.write("/context/draft.md", "draft v1")
    # Simulate a second invocation reattaching to the same inner sandbox.
    backend2 = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    with backend2:
        result = backend2.read("/context/draft.md")
    assert result.error is None
    assert "draft v1" in result.file_data["content"]


def test_reattach_overrides_stale_materialized_files_with_current_snapshot():
    hub, inner = _seeded_pair()
    # Plant a stale file in the inner sandbox that would shadow the
    # hub contents if hydration didn't overwrite.
    inner.files["/context/AGENTS.md"] = b"STALE LOCAL OVERRIDE"
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    with backend:
        result = backend.read("/context/AGENTS.md")
    assert "STALE LOCAL OVERRIDE" not in (result.file_data or {}).get("content", "")
    assert "hi" in (result.file_data or {}).get("content", "")


# ---------------------------------------------------------------------------
# on_exit flush errors
# ---------------------------------------------------------------------------


def test_on_exit_flush_failure_surfaces_to_caller_and_inner_still_exits():
    hub, inner = _seeded_pair()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent",
        commit_mode="on_exit",
    )
    with pytest.raises(HubError):
        with backend:
            backend.write("/context/buf.md", "buf")
            hub.fail_next_push = HubError("hub offline")
    # Inner backend was still released so the sandbox doesn't leak.
    assert inner.exited is True


# ---------------------------------------------------------------------------
# deepagents construction smoke
# ---------------------------------------------------------------------------


def test_deepagents_create_can_at_least_resolve_synced_backend():
    """Constructive smoke test: deepagents should accept a
    `SandboxBackendProtocol` value. We don't run the agent loop here
    because that requires a real LLM."""
    try:
        from deepagents.backends.protocol import SandboxBackendProtocol
    except ImportError:
        pytest.skip("deepagents not available")
    hub, inner = _seeded_pair()
    backend = ContextHubSyncedSandboxBackend(
        inner=inner, hub_client=hub, identifier="team/agent"
    )
    assert isinstance(backend, SandboxBackendProtocol)

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

"""Smoke tests for the package's public API."""

from __future__ import annotations

from langchain_agent_sandbox.context_hub_models import FileEntry as _FE

from tests.fake_context_hub import FakeContextHubClient
from tests.fake_sandbox_backend import FakeSandboxBackend


def test_existing_imports_still_work():
    from langchain_agent_sandbox import (
        AgentSandboxBackend,
        SandboxPolicyWrapper,
        create_sandbox_backend_factory,
    )

    assert AgentSandboxBackend.__name__ == "AgentSandboxBackend"
    assert SandboxPolicyWrapper.__name__ == "SandboxPolicyWrapper"
    assert callable(create_sandbox_backend_factory)


def test_new_imports_resolve_from_top_level():
    from langchain_agent_sandbox import (
        AgentContext,
        AgentEntry,
        ContextHubClientProtocol,
        ContextHubSyncedSandboxBackend,
        FileEntry,
        HubAuthError,
        HubConflictError,
        HubError,
        HubNotFoundError,
        HubRateLimitError,
        HubValidationError,
        SkillContext,
        SkillEntry,
        create_context_hub_synced_backend_factory,
    )

    # Sanity: subclass relationships hold.
    assert issubclass(HubConflictError, HubError)
    assert issubclass(HubNotFoundError, HubError)
    assert issubclass(HubValidationError, HubError)
    assert issubclass(HubAuthError, HubError)
    assert issubclass(HubRateLimitError, HubError)

    # Literal type aliases are part of the public surface so downstream
    # type annotations don't need to redeclare the legal value set.
    from langchain_agent_sandbox import CommitMode, ContextWriteMode, RepoType

    val: CommitMode = "per_operation"
    val2: ContextWriteMode = "context_hub"
    val3: RepoType = "agent"
    assert (val, val2, val3) == ("per_operation", "context_hub", "agent")
    # The protocol class is importable but it's a Protocol, so we don't
    # instantiate it here — just confirm it's a class.
    assert isinstance(ContextHubClientProtocol, type)
    assert FileEntry(content="x").type == "file"
    assert AgentEntry(repo_handle="r").type == "agent"
    assert SkillEntry(repo_handle="r").type == "skill"
    assert AgentContext.__name__ == "AgentContext"
    assert SkillContext.__name__ == "SkillContext"
    assert ContextHubSyncedSandboxBackend.__name__ == (
        "ContextHubSyncedSandboxBackend"
    )
    assert callable(create_context_hub_synced_backend_factory)


def test_context_hub_synced_backend_factory_eagerly_hydrates_and_cleans_up():
    from langchain_agent_sandbox import create_context_hub_synced_backend_factory

    hub = FakeContextHubClient()
    hub.seed_agent("team/agent", {"AGENTS.md": _FE(content="hi")})
    inner = FakeSandboxBackend()
    factory = create_context_hub_synced_backend_factory(
        inner_factory=lambda _runtime: inner,
        hub_client=hub,
        identifier="team/agent",
        mount_prefix="/context",
    )
    backend = factory(None)
    try:
        assert inner.entered is True
        assert inner.files["/context/AGENTS.md"] == b"hi"
        assert backend.has_prior_commits() is True
    finally:
        # Manual cleanup mirrors what the finalizer does, but
        # deterministically so the test isn't GC-order sensitive.
        backend._finalizer()  # type: ignore[attr-defined]
    assert inner.exited is True


def test_factory_passes_through_kwargs():
    from langchain_agent_sandbox import create_context_hub_synced_backend_factory

    hub = FakeContextHubClient()
    hub.seed_agent("team/agent", {"AGENTS.md": _FE(content="hi")})
    inner = FakeSandboxBackend()
    factory = create_context_hub_synced_backend_factory(
        inner_factory=lambda _runtime: inner,
        hub_client=hub,
        identifier="team/agent",
        mount_prefix="/ctx",
        commit_mode="manual",
    )
    backend = factory(None)
    try:
        push_count_before = len(hub.push_calls)
        result = backend.write("/ctx/new.md", "x")
        assert result.error is None
        # mount_prefix took effect: write under /ctx materialized into
        # the inner sandbox under that path (not /context).
        assert "/ctx/new.md" in inner.files
        # commit_mode=manual: hub didn't receive a push, the change is
        # buffered until flush().
        assert len(hub.push_calls) == push_count_before
        assert backend.pending_changes() == ("new.md",)
    finally:
        backend._finalizer()  # type: ignore[attr-defined]

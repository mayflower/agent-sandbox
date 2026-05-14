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

"""Tests for :class:`ContextHubHttpClient` against the documented contract.

Uses :class:`httpx.MockTransport` (or any other in-process transport)
so the tests never hit the network. The real server contract is mirrored
in ``docs/server-contract.md`` and exercised here.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from langchain_agent_sandbox.context_hub_client import (
    HubAuthError,
    HubConflictError,
    HubError,
    HubNotFoundError,
    HubRateLimitError,
    HubValidationError,
)
from langchain_agent_sandbox.context_hub_http_client import ContextHubHttpClient
from langchain_agent_sandbox.context_hub_models import (
    AgentEntry,
    FileEntry,
    SkillEntry,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _Recorder:
    """Captures request bodies for assertion."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.next_responses: list[httpx.Response] = []

    def add(self, response: httpx.Response) -> None:
        self.next_responses.append(response)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.next_responses:
            raise AssertionError(f"unexpected request {request.method} {request.url}")
        return self.next_responses.pop(0)


def _client_with(handler) -> ContextHubHttpClient:
    transport = httpx.MockTransport(handler)
    return ContextHubHttpClient(
        base_url="https://hub.test",
        api_key="secret",
        transport=transport,
    )


def _json_body(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content.decode("utf-8"))


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------


def test_push_agent_sends_repo_type_and_files_payload():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            201,
            json={"commit": {"commit_hash": "00000001", "id": "commit-00000001"}},
        )
    )
    client = _client_with(rec.handler)
    url = client.push_agent(
        "team/email",
        files={
            "AGENTS.md": FileEntry(content="hi"),
            "skills/research": SkillEntry(repo_handle="research"),
        },
        description="email assistant",
        tags=["email"],
        is_public=False,
    )
    assert url.endswith(":00000001")
    request = rec.requests[-1]
    assert request.method == "POST"
    assert request.url.path == "/v1/platform/hub/repos/team/email/directories/commits"
    assert request.url.params.get("repo_type") == "agent"
    body = _json_body(request)
    assert body["files"]["AGENTS.md"] == {"type": "file", "content": "hi"}
    assert body["files"]["skills/research"]["type"] == "skill"
    assert body["files"]["skills/research"]["repo_handle"] == "research"
    assert body["parent_commit"] is None
    assert body["description"] == "email assistant"
    assert body["tags"] == ["email"]
    assert body["is_public"] is False
    assert request.headers["authorization"] == "Bearer secret"


def test_push_skill_uses_skill_repo_type():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            201,
            json={"commit": {"commit_hash": "00000002", "id": "commit-00000002"}},
        )
    )
    client = _client_with(rec.handler)
    client.push_skill(
        "team/research", files={"SKILL.md": FileEntry(content="s")}
    )
    request = rec.requests[-1]
    assert request.url.params.get("repo_type") == "skill"


def test_push_serializes_deletion_via_none():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            201,
            json={"commit": {"commit_hash": "00000003", "id": "commit-00000003"}},
        )
    )
    client = _client_with(rec.handler)
    client.push_agent(
        "team/email",
        files={"a.md": None},
        parent_commit="aaaaaaaa",
    )
    body = _json_body(rec.requests[-1])
    assert body["files"]["a.md"] is None
    assert body["parent_commit"] == "aaaaaaaa"


# ---------------------------------------------------------------------------
# Pull
# ---------------------------------------------------------------------------


def test_pull_agent_maps_files_to_dataclasses():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={
                "commit_hash": "deadbeef",
                "commit_id": "commit-deadbeef",
                "files": {
                    "AGENTS.md": {"type": "file", "content": "hi"},
                    "skills/research": {
                        "type": "skill",
                        "repo_handle": "research",
                    },
                    "agents/scheduler": {
                        "type": "agent",
                        "repo_handle": "scheduler",
                        "owner": "team",
                    },
                },
            },
        )
    )
    client = _client_with(rec.handler)
    ctx = client.pull_agent("team/email")
    assert ctx.commit_hash == "deadbeef"
    assert isinstance(ctx.files["AGENTS.md"], FileEntry)
    assert isinstance(ctx.files["skills/research"], SkillEntry)
    assert isinstance(ctx.files["agents/scheduler"], AgentEntry)
    assert ctx.files["agents/scheduler"].owner == "team"
    request = rec.requests[-1]
    assert request.method == "GET"
    assert request.url.path == "/v1/platform/hub/repos/team/email/directories"
    assert request.url.params.get("repo_type") == "agent"


def test_pull_skill_uses_skill_repo_type():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={
                "commit_hash": "deadbeef",
                "commit_id": "commit-deadbeef",
                "files": {"SKILL.md": {"type": "file", "content": "s"}},
            },
        )
    )
    client = _client_with(rec.handler)
    client.pull_skill("team/research")
    request = rec.requests[-1]
    assert request.url.params.get("repo_type") == "skill"


def test_pull_passes_version_param():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={
                "commit_hash": "deadbeef",
                "commit_id": "commit-deadbeef",
                "files": {},
            },
        )
    )
    client = _client_with(rec.handler)
    client.pull_agent("team/email", version="production")
    request = rec.requests[-1]
    assert request.url.params.get("commit") == "production"


def test_pull_inline_version_forwarded_to_commit_param():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={"commit_hash": "abc12345", "commit_id": "x", "files": {}},
        )
    )
    client = _client_with(rec.handler)
    client.pull_agent("team/email:abc12345")
    request = rec.requests[-1]
    assert request.url.params.get("commit") == "abc12345"


# ---------------------------------------------------------------------------
# Status-code mapping
# ---------------------------------------------------------------------------


def test_409_maps_to_conflict_error():
    rec = _Recorder()
    rec.add(httpx.Response(409, json={"message": "parent_commit drift"}))
    client = _client_with(rec.handler)
    with pytest.raises(HubConflictError):
        client.push_agent("team/email", files={"a.md": FileEntry(content="a")})


def test_404_maps_to_not_found_error():
    rec = _Recorder()
    rec.add(httpx.Response(404, json={"message": "missing"}))
    client = _client_with(rec.handler)
    with pytest.raises(HubNotFoundError):
        client.pull_agent("team/missing")


def test_401_maps_to_auth_error():
    rec = _Recorder()
    rec.add(httpx.Response(401, json={"message": "unauthorized"}))
    client = _client_with(rec.handler)
    with pytest.raises(HubAuthError):
        client.pull_agent("team/email")


def test_403_maps_to_auth_error():
    rec = _Recorder()
    rec.add(httpx.Response(403, json={"message": "forbidden"}))
    client = _client_with(rec.handler)
    with pytest.raises(HubAuthError):
        client.pull_agent("team/email")


def test_429_maps_to_rate_limit_error():
    rec = _Recorder()
    rec.add(httpx.Response(429, json={"message": "slow down"}))
    client = _client_with(rec.handler)
    with pytest.raises(HubRateLimitError):
        client.pull_agent("team/email")


def test_422_maps_to_validation_error():
    rec = _Recorder()
    rec.add(httpx.Response(422, json={"message": "bad payload"}))
    client = _client_with(rec.handler)
    with pytest.raises(HubValidationError):
        client.push_agent("team/email", files={"a.md": FileEntry(content="a")})


def test_500_maps_to_generic_hub_error():
    rec = _Recorder()
    rec.add(httpx.Response(500, json={"message": "boom"}))
    client = _client_with(rec.handler)
    with pytest.raises(HubError):
        client.pull_agent("team/email")


# ---------------------------------------------------------------------------
# Repo metadata + listing + delete
# ---------------------------------------------------------------------------


def test_list_agents_serializes_query_params():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={
                "repos": [
                    {
                        "owner": "team",
                        "repo_handle": "email",
                        "repo_type": "agent",
                        "commit_hash": "abc",
                    }
                ],
                "limit": 10,
                "offset": 0,
                "total": 1,
            },
        )
    )
    client = _client_with(rec.handler)
    out = client.list_agents(
        limit=10, offset=5, is_public=True, is_archived=False, query="email"
    )
    request = rec.requests[-1]
    assert request.method == "GET"
    assert request.url.params.get("repo_type") == "agent"
    assert request.url.params.get("limit") == "10"
    assert request.url.params.get("offset") == "5"
    assert request.url.params.get("is_public") == "true"
    assert request.url.params.get("is_archived") == "false"
    assert request.url.params.get("query") == "email"
    assert out["total"] == 1


def test_list_skills_uses_skill_repo_type():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={"repos": [], "limit": 100, "offset": 0, "total": 0},
        )
    )
    client = _client_with(rec.handler)
    client.list_skills()
    assert rec.requests[-1].url.params.get("repo_type") == "skill"


def test_agent_exists_true_on_200():
    rec = _Recorder()
    rec.add(httpx.Response(200, json={"owner": "team", "repo_handle": "email"}))
    client = _client_with(rec.handler)
    assert client.agent_exists("team/email") is True


def test_agent_exists_false_on_404():
    rec = _Recorder()
    rec.add(httpx.Response(404, json={"message": "nope"}))
    client = _client_with(rec.handler)
    assert client.agent_exists("team/missing") is False


def test_delete_agent_sends_delete_request_with_repo_type():
    rec = _Recorder()
    rec.add(httpx.Response(204))
    client = _client_with(rec.handler)
    client.delete_agent("team/email")
    request = rec.requests[-1]
    assert request.method == "DELETE"
    assert request.url.params.get("repo_type") == "agent"


def test_delete_skill_sends_delete_request_with_repo_type():
    rec = _Recorder()
    rec.add(httpx.Response(204))
    client = _client_with(rec.handler)
    client.delete_skill("team/research")
    request = rec.requests[-1]
    assert request.url.params.get("repo_type") == "skill"


# ---------------------------------------------------------------------------
# Tags / promotions
# ---------------------------------------------------------------------------


def test_tag_commit_calls_put_tags_endpoint():
    rec = _Recorder()
    rec.add(httpx.Response(204))
    client = _client_with(rec.handler)
    client.tag_commit("team/email", "v1", "00000001", repo_type="agent")
    request = rec.requests[-1]
    assert request.method == "PUT"
    assert request.url.path == "/repos/team/email/tags/v1"
    assert request.url.params.get("repo_type") == "agent"
    body = _json_body(request)
    assert body == {"commit_hash": "00000001"}


def test_promote_calls_promotions_endpoint():
    rec = _Recorder()
    rec.add(httpx.Response(204))
    client = _client_with(rec.handler)
    client.promote(
        "team/email", "production", "00000001", repo_type="agent"
    )
    request = rec.requests[-1]
    assert request.method == "POST"
    assert request.url.path == "/repos/team/email/promotions/production"
    body = _json_body(request)
    assert body == {"commit_hash": "00000001"}


# ---------------------------------------------------------------------------
# Identifier resolution
# ---------------------------------------------------------------------------


def test_repo_only_identifier_uses_default_owner_in_path():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={"commit_hash": "x", "commit_id": "x", "files": {}},
        )
    )
    client = _client_with(rec.handler)
    client.pull_agent("email")
    request = rec.requests[-1]
    assert "/default/email/" in str(request.url.path)


def test_dash_owner_passed_through_verbatim():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={"commit_hash": "x", "commit_id": "x", "files": {}},
        )
    )
    client = _client_with(rec.handler)
    client.pull_agent("-/email")
    request = rec.requests[-1]
    assert "/-/email/" in str(request.url.path)


def test_explicit_version_overrides_inline_version():
    rec = _Recorder()
    rec.add(
        httpx.Response(
            200,
            json={"commit_hash": "x", "commit_id": "x", "files": {}},
        )
    )
    client = _client_with(rec.handler)
    client.pull_agent("team/email:staging", version="production")
    request = rec.requests[-1]
    assert request.url.params.get("commit") == "production"

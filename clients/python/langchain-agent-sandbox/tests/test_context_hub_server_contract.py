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

"""End-to-end server-contract test using :class:`ContextHubHttpClient`
against an in-process ``httpx.MockTransport``-backed fake server.

This is the documented Open Context Hub HTTP contract from
``docs/server-contract.md``. The fake server is intentionally tiny — it
exists so the ``ContextHubSyncedSandboxBackend`` can be exercised
through real HTTP serialization without launching a process.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from langchain_agent_sandbox.context_hub_client import (
    HubConflictError,
    HubNotFoundError,
)
from langchain_agent_sandbox.context_hub_http_client import ContextHubHttpClient
from langchain_agent_sandbox.context_hub_models import FileEntry, SkillEntry


# ---------------------------------------------------------------------------
# In-process fake server
# ---------------------------------------------------------------------------


@dataclass
class _Repo:
    files: dict[str, dict[str, Any]] = field(default_factory=dict)
    commit_hash: str | None = None
    commit_id: str | None = None
    tags: dict[str, str] = field(default_factory=dict)
    snapshots: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    description: str | None = None
    is_public: bool = False
    is_archived: bool = False
    resource_tags: list[str] = field(default_factory=list)


class _FakeServer:
    def __init__(self) -> None:
        self.repos: dict[tuple[str, str, str], _Repo] = {}
        self._counter = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        params = request.url.params
        if method == "POST" and re.match(
            r"^/v1/platform/hub/repos/[^/]+/[^/]+/directories/commits$", path
        ):
            return self._commit(request, params)
        if method == "GET" and re.match(
            r"^/v1/platform/hub/repos/[^/]+/[^/]+/directories$", path
        ):
            return self._snapshot(request, params)
        if method == "GET" and path == "/repos":
            return self._list(params)
        if method == "GET" and re.match(r"^/repos/[^/]+/[^/]+$", path):
            return self._head_repo(request, params)
        if method == "DELETE" and re.match(r"^/repos/[^/]+/[^/]+$", path):
            return self._delete_repo(request, params)
        if method == "PUT" and re.match(r"^/repos/[^/]+/[^/]+/tags/[^/]+$", path):
            return self._tag(request, params)
        if method == "POST" and re.match(
            r"^/repos/[^/]+/[^/]+/promotions/[^/]+$", path
        ):
            return self._promote(request, params)
        return httpx.Response(404, json={"message": f"no route for {method} {path}"})

    # path parsing helper
    @staticmethod
    def _split(path: str, offset: int) -> tuple[str, str]:
        parts = path.split("/")
        return parts[offset], parts[offset + 1]

    def _key(self, request: httpx.Request, params, offset: int) -> tuple[str, str, str]:
        repo_type = params.get("repo_type") or "agent"
        owner, name = self._split(request.url.path, offset)
        return repo_type, owner, name

    def _commit(self, request: httpx.Request, params) -> httpx.Response:
        key = self._key(request, params, 5)
        body = json.loads(request.content.decode("utf-8"))
        parent_commit = body.get("parent_commit")
        files = body.get("files") or {}
        repo = self.repos.setdefault(key, _Repo())
        if (
            parent_commit is not None
            and repo.commit_hash is not None
            and parent_commit != repo.commit_hash
        ):
            return httpx.Response(
                409,
                json={"message": f"parent {parent_commit} != head {repo.commit_hash}"},
            )
        for p, entry in files.items():
            if entry is None:
                repo.files.pop(p, None)
            else:
                repo.files[p] = entry
        self._counter += 1
        repo.commit_hash = f"{self._counter:08x}"
        repo.commit_id = f"commit-{repo.commit_hash}"
        repo.snapshots[repo.commit_hash] = dict(repo.files)
        if "description" in body:
            repo.description = body["description"]
        if "tags" in body:
            repo.resource_tags = list(body["tags"])
        if "is_public" in body:
            repo.is_public = bool(body["is_public"])
        return httpx.Response(
            201,
            json={
                "commit": {
                    "commit_hash": repo.commit_hash,
                    "id": repo.commit_id,
                }
            },
        )

    def _snapshot(self, request: httpx.Request, params) -> httpx.Response:
        key = self._key(request, params, 5)
        repo = self.repos.get(key)
        if repo is None:
            return httpx.Response(404, json={"message": "repo not found"})
        version = params.get("commit")
        if version:
            tag_hash = repo.tags.get(version)
            if tag_hash is not None:
                snapshot = repo.snapshots.get(tag_hash, repo.files)
            elif version == repo.commit_hash:
                snapshot = repo.files
            else:
                snapshot = repo.snapshots.get(version)
                if snapshot is None:
                    return httpx.Response(
                        404, json={"message": f"version {version} not found"}
                    )
        else:
            snapshot = repo.files
        return httpx.Response(
            200,
            json={
                "commit_hash": repo.commit_hash,
                "commit_id": repo.commit_id,
                "files": snapshot,
            },
        )

    def _list(self, params) -> httpx.Response:
        repo_type = params.get("repo_type") or "agent"
        limit = int(params.get("limit") or 100)
        offset = int(params.get("offset") or 0)
        query = params.get("query") or ""
        is_public = params.get("is_public")
        is_archived = params.get("is_archived")
        rows: list[dict[str, Any]] = []
        for (typ, owner, name), repo in self.repos.items():
            if typ != repo_type:
                continue
            if is_public is not None and (
                ("true" if repo.is_public else "false") != is_public
            ):
                continue
            if is_archived is not None and (
                ("true" if repo.is_archived else "false") != is_archived
            ):
                continue
            if query and query not in f"{owner}/{name}":
                continue
            rows.append(
                {
                    "owner": owner,
                    "repo_handle": name,
                    "repo_type": typ,
                    "commit_hash": repo.commit_hash,
                }
            )
        return httpx.Response(
            200,
            json={
                "repos": rows[offset : offset + limit],
                "limit": limit,
                "offset": offset,
                "total": len(rows),
            },
        )

    def _head_repo(self, request: httpx.Request, params) -> httpx.Response:
        key = self._key(request, params, 2)
        repo = self.repos.get(key)
        if repo is None:
            return httpx.Response(404, json={"message": "repo not found"})
        return httpx.Response(
            200,
            json={
                "owner": key[1],
                "repo_handle": key[2],
                "repo_type": key[0],
                "commit_hash": repo.commit_hash,
            },
        )

    def _delete_repo(self, request: httpx.Request, params) -> httpx.Response:
        key = self._key(request, params, 2)
        self.repos.pop(key, None)
        return httpx.Response(204)

    def _tag(self, request: httpx.Request, params) -> httpx.Response:
        repo_type = params.get("repo_type") or "agent"
        parts = request.url.path.split("/")
        owner, name, tag = parts[2], parts[3], parts[5]
        repo = self.repos.get((repo_type, owner, name))
        if repo is None:
            return httpx.Response(404, json={"message": "repo not found"})
        body = json.loads(request.content.decode("utf-8"))
        repo.tags[tag] = body["commit_hash"]
        return httpx.Response(204)

    def _promote(self, request: httpx.Request, params) -> httpx.Response:
        repo_type = params.get("repo_type") or "agent"
        parts = request.url.path.split("/")
        owner, name, env = parts[2], parts[3], parts[5]
        repo = self.repos.get((repo_type, owner, name))
        if repo is None:
            return httpx.Response(404, json={"message": "repo not found"})
        body = json.loads(request.content.decode("utf-8"))
        repo.tags[env] = body["commit_hash"]
        return httpx.Response(204)


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


@pytest.fixture()
def client():
    server = _FakeServer()
    transport = httpx.MockTransport(server)
    c = ContextHubHttpClient(
        base_url="https://hub.test", api_key="t", transport=transport
    )
    try:
        yield c
    finally:
        c.close()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_push_then_pull_agent_round_trip(client):
    url = client.push_agent(
        "team/email",
        files={
            "AGENTS.md": FileEntry(content="email agent"),
            "skills/research": SkillEntry(repo_handle="research"),
        },
        description="Email assistant",
        tags=["email"],
        is_public=False,
    )
    assert ":" in url
    pulled = client.pull_agent("team/email")
    assert isinstance(pulled.files["AGENTS.md"], FileEntry)
    assert pulled.files["AGENTS.md"].content == "email agent"
    assert isinstance(pulled.files["skills/research"], SkillEntry)


def test_push_then_pull_skill_round_trip(client):
    client.push_skill(
        "team/research", files={"SKILL.md": FileEntry(content="research")}
    )
    pulled = client.pull_skill("team/research")
    assert pulled.files["SKILL.md"].content == "research"


def test_delete_entry_over_http_round_trip(client):
    client.push_agent(
        "team/delete-test",
        files={"a.md": FileEntry(content="a"), "b.md": FileEntry(content="b")},
    )
    head = client.pull_agent("team/delete-test").commit_hash
    assert head is not None
    client.push_agent(
        "team/delete-test", files={"a.md": None}, parent_commit=head
    )
    pulled = client.pull_agent("team/delete-test")
    assert "a.md" not in pulled.files
    assert "b.md" in pulled.files


def test_parent_commit_conflict_over_http(client):
    client.push_agent("team/conflict", files={"a.md": FileEntry(content="a")})
    with pytest.raises(HubConflictError):
        client.push_agent(
            "team/conflict",
            files={"b.md": FileEntry(content="b")},
            parent_commit="deadbeef",
        )


def test_promotion_and_tagged_pull_over_http(client):
    client.push_agent("team/promote", files={"AGENTS.md": FileEntry(content="v1")})
    head = client.pull_agent("team/promote").commit_hash
    assert head is not None
    client.promote("team/promote", "production", head, repo_type="agent")
    prod = client.pull_agent("team/promote:production")
    assert prod.commit_hash == head


def test_tag_then_pull_via_tag(client):
    client.push_agent("team/t", files={"a.md": FileEntry(content="x")})
    head = client.pull_agent("team/t").commit_hash
    assert head is not None
    client.tag_commit("team/t", "v1", head, repo_type="agent")
    via_tag = client.pull_agent("team/t:v1")
    assert via_tag.commit_hash == head


def test_list_exists_delete_round_trip(client):
    client.push_skill(
        "team/listable",
        files={"SKILL.md": FileEntry(content="x")},
        is_public=True,
        tags=["x"],
    )
    assert client.skill_exists("team/listable") is True
    result = client.list_skills(is_public=True, query="listable")
    assert result["total"] == 1
    client.delete_skill("team/listable")
    assert client.skill_exists("team/listable") is False


def test_pull_missing_repo_raises_not_found(client):
    with pytest.raises(HubNotFoundError):
        client.pull_agent("team/missing")

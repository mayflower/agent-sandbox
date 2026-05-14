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

from langchain_agent_sandbox.context_hub_client import (
    HubConflictError,
    HubNotFoundError,
    parse_context_hub_identifier,
)
from langchain_agent_sandbox.context_hub_models import (
    AgentEntry,
    FileEntry,
    SkillEntry,
)

from tests.fake_context_hub import FakeContextHubClient


def test_file_and_link_entries_round_trip():
    f = FileEntry(content="hello")
    a = AgentEntry(repo_handle="scheduler", owner="team", commit_hash="aaaaaaaa")
    s = SkillEntry(repo_handle="research")

    assert f.type == "file"
    assert f.content == "hello"
    assert a.type == "agent"
    assert a.repo_handle == "scheduler"
    assert s.type == "skill"


def test_identifier_parsing_forms():
    assert parse_context_hub_identifier("repo").name == "repo"
    assert parse_context_hub_identifier("team/repo").owner == "team"
    assert parse_context_hub_identifier("team/repo:production").version == "production"
    assert parse_context_hub_identifier("repo:aaaaaaaa").version == "aaaaaaaa"
    assert parse_context_hub_identifier("-/repo").owner == "-"
    parsed = parse_context_hub_identifier("team/repo:staging", version="production")
    assert parsed.version == "production"


def test_push_pull_agent_and_skill():
    hub = FakeContextHubClient()
    url = hub.push_agent("team/email", files={"AGENTS.md": FileEntry(content="hi")})
    assert url.endswith(":00000001")
    agent = hub.pull_agent("team/email")
    assert agent.commit_hash == "00000001"
    assert agent.files["AGENTS.md"].content == "hi"

    hub.push_skill(
        "team/research", files={"SKILL.md": FileEntry(content="research")}
    )
    skill = hub.pull_skill("team/research")
    assert skill.files["SKILL.md"].content == "research"


def test_push_delete_entry_removes_path():
    hub = FakeContextHubClient()
    hub.push_agent(
        "team/email",
        files={"a.md": FileEntry(content="a"), "b.md": FileEntry(content="b")},
    )
    head = hub.pull_agent("team/email").commit_hash
    hub.push_agent("team/email", files={"a.md": None}, parent_commit=head)
    pulled = hub.pull_agent("team/email")
    assert "a.md" not in pulled.files
    assert "b.md" in pulled.files


def test_parent_commit_conflict_raises():
    hub = FakeContextHubClient()
    hub.push_agent("team/email", files={"a.md": FileEntry(content="a")})
    with pytest.raises(HubConflictError):
        hub.push_agent(
            "team/email",
            files={"b.md": FileEntry(content="b")},
            parent_commit="deadbeef",
        )


def test_linked_entries_preserved_on_pull():
    hub = FakeContextHubClient()
    hub.push_agent(
        "team/email",
        files={
            "AGENTS.md": FileEntry(content="hi"),
            "skills/research": SkillEntry(repo_handle="research"),
            "agents/scheduler": AgentEntry(repo_handle="scheduler"),
        },
    )
    pulled = hub.pull_agent("team/email")
    assert isinstance(pulled.files["skills/research"], SkillEntry)
    assert isinstance(pulled.files["agents/scheduler"], AgentEntry)


def test_agent_exists_list_delete():
    hub = FakeContextHubClient()
    assert not hub.agent_exists("team/email")
    hub.push_agent(
        "team/email",
        files={"AGENTS.md": FileEntry(content="hi")},
        tags=["email"],
        is_public=True,
    )
    assert hub.agent_exists("team/email")
    listed = hub.list_agents(is_public=True, query="email")
    assert listed["total"] == 1
    hub.delete_agent("team/email")
    assert not hub.agent_exists("team/email")


def test_skill_exists_list_delete():
    hub = FakeContextHubClient()
    assert not hub.skill_exists("team/r")
    hub.push_skill(
        "team/r", files={"SKILL.md": FileEntry(content="s")}, is_public=True
    )
    assert hub.skill_exists("team/r")
    listed = hub.list_skills(is_public=True)
    assert listed["total"] == 1
    hub.delete_skill("team/r")
    assert not hub.skill_exists("team/r")


def test_tags_resolution_via_inline_and_kwarg():
    hub = FakeContextHubClient()
    hub.push_agent("team/email", files={"AGENTS.md": FileEntry(content="hi")})
    head = hub.pull_agent("team/email").commit_hash
    assert head is not None
    hub.promote("team/email", "production", head, repo_type="agent")
    prod = hub.pull_agent("team/email:production")
    assert prod.commit_hash == head
    prod2 = hub.pull_agent("team/email:staging", version="production")
    assert prod2.commit_hash == head


def test_pull_unknown_version_raises_not_found():
    hub = FakeContextHubClient()
    hub.push_agent("team/email", files={"AGENTS.md": FileEntry(content="hi")})
    with pytest.raises(HubNotFoundError):
        hub.pull_agent("team/email:nope")


def test_pull_missing_repo_raises_not_found():
    hub = FakeContextHubClient()
    with pytest.raises(HubNotFoundError):
        hub.pull_agent("team/missing")

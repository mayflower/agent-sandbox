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

from langchain_agent_sandbox.context_hub_models import (
    AgentContext,
    AgentEntry,
    FileEntry,
    SkillContext,
    SkillEntry,
    entry_from_mapping,
    entry_to_mapping,
    is_valid_parent_commit,
    parse_context_hub_identifier,
)


def test_file_entry_serializes_to_dict_with_type():
    entry = FileEntry(content="hello")
    assert entry.type == "file"
    assert entry.content == "hello"
    payload = entry_to_mapping(entry)
    assert payload == {"type": "file", "content": "hello"}


def test_agent_entry_serializes_to_dict_with_type():
    entry = AgentEntry(repo_handle="scheduler", owner="team", commit_hash="aaaaaaaa")
    assert entry.type == "agent"
    payload = entry_to_mapping(entry)
    assert payload["type"] == "agent"
    assert payload["repo_handle"] == "scheduler"
    assert payload["owner"] == "team"
    assert payload["commit_hash"] == "aaaaaaaa"


def test_skill_entry_serializes_to_dict_with_type():
    entry = SkillEntry(repo_handle="research")
    assert entry.type == "skill"
    payload = entry_to_mapping(entry)
    assert payload["type"] == "skill"
    assert payload["repo_handle"] == "research"
    assert "owner" not in payload or payload["owner"] is None


def test_entry_round_trips_through_mapping():
    cases = [
        FileEntry(content="x"),
        AgentEntry(repo_handle="s", owner="o", commit_id="cid", commit_hash="aaaaaaaa"),
        SkillEntry(repo_handle="s"),
    ]
    for original in cases:
        mapped = entry_to_mapping(original)
        rebuilt = entry_from_mapping(mapped)
        assert rebuilt == original


def test_entry_from_mapping_accepts_duck_typed_objects():
    class DuckFile:
        type = "file"
        content = "ducky"

    rebuilt = entry_from_mapping(DuckFile())
    assert isinstance(rebuilt, FileEntry)
    assert rebuilt.content == "ducky"


def test_entry_from_mapping_rejects_unknown_type():
    with pytest.raises(ValueError):
        entry_from_mapping({"type": "weird", "content": "x"})


def test_agent_context_preserves_commit_metadata():
    ctx = AgentContext(
        files={"AGENTS.md": FileEntry(content="hi")},
        commit_hash="aaaaaaaa",
        commit_id="commit-aaaaaaaa",
    )
    assert ctx.commit_hash == "aaaaaaaa"
    assert ctx.commit_id == "commit-aaaaaaaa"
    assert "AGENTS.md" in ctx.files


def test_skill_context_preserves_commit_metadata():
    ctx = SkillContext(
        files={"SKILL.md": FileEntry(content="s")},
        commit_hash="bbbbbbbb",
        commit_id="commit-bbbbbbbb",
    )
    assert ctx.commit_hash == "bbbbbbbb"
    assert ctx.commit_id == "commit-bbbbbbbb"


def test_identifier_parser_repo_only_uses_default_owner():
    parsed = parse_context_hub_identifier("repo")
    assert parsed.owner == "default"
    assert parsed.name == "repo"
    assert parsed.version is None


def test_identifier_parser_owner_and_name():
    parsed = parse_context_hub_identifier("owner/repo")
    assert parsed.owner == "owner"
    assert parsed.name == "repo"


def test_identifier_parser_inline_version():
    parsed = parse_context_hub_identifier("owner/repo:production")
    assert parsed.owner == "owner"
    assert parsed.name == "repo"
    assert parsed.version == "production"


def test_identifier_parser_repo_and_inline_version_no_owner():
    parsed = parse_context_hub_identifier("repo:aaaaaaaa")
    assert parsed.owner == "default"
    assert parsed.name == "repo"
    assert parsed.version == "aaaaaaaa"


def test_identifier_parser_dash_owner_marker_preserved():
    parsed = parse_context_hub_identifier("-/repo")
    assert parsed.owner == "-"
    assert parsed.name == "repo"


def test_identifier_parser_version_kwarg_overrides_inline():
    parsed = parse_context_hub_identifier("owner/repo:staging", version="production")
    assert parsed.version == "production"


def test_identifier_parser_empty_string_is_invalid():
    with pytest.raises(ValueError):
        parse_context_hub_identifier("")


def test_identifier_parser_rejects_control_chars():
    with pytest.raises(ValueError):
        parse_context_hub_identifier("owner/repo\x00")


@pytest.mark.parametrize(
    "candidate",
    [
        None,
        "aaaaaaaa",
        "a" * 8,
        "abcd1234abcd1234",
        "0" * 64,
    ],
)
def test_parent_commit_validator_accepts_valid(candidate):
    assert is_valid_parent_commit(candidate) is True


@pytest.mark.parametrize(
    "candidate",
    [
        "",
        "abc",
        "abcdefg",
        "a" * 65,
        "AAAAAAAAA",
        "zzzzzzzz",
        "aaaa-bbbb",
        "aaaa aaaa",
    ],
)
def test_parent_commit_validator_rejects_invalid(candidate):
    assert is_valid_parent_commit(candidate) is False

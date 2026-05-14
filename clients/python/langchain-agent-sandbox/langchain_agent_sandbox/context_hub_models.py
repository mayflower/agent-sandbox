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

"""Context Hub data model (no ``langsmith`` runtime dependency)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Literal, Mapping, Optional, Union


@dataclass(frozen=True)
class FileEntry:
    content: str
    type: Literal["file"] = field(default="file", init=False)


@dataclass(frozen=True)
class _LinkedRepoEntry:
    repo_handle: str
    owner: Optional[str] = None
    commit_id: Optional[str] = None
    commit_hash: Optional[str] = None


@dataclass(frozen=True)
class AgentEntry(_LinkedRepoEntry):
    type: Literal["agent"] = field(default="agent", init=False)


@dataclass(frozen=True)
class SkillEntry(_LinkedRepoEntry):
    type: Literal["skill"] = field(default="skill", init=False)


Entry = Union[FileEntry, AgentEntry, SkillEntry]


def _freeze_files(files: Mapping[str, Entry]) -> Mapping[str, Entry]:
    return MappingProxyType(dict(files))


@dataclass(frozen=True)
class _RepoContext:
    files: Mapping[str, Entry] = field(default_factory=dict)
    commit_hash: Optional[str] = None
    commit_id: Optional[str] = None

    def __post_init__(self) -> None:
        # Replace the supplied mapping with a read-only view so the
        # frozen dataclass invariant holds for the container too — not
        # just the attribute reference. Bypass the frozen guard via
        # ``object.__setattr__``.
        object.__setattr__(self, "files", _freeze_files(self.files))


@dataclass(frozen=True)
class AgentContext(_RepoContext):
    pass


@dataclass(frozen=True)
class SkillContext(_RepoContext):
    pass


@dataclass(frozen=True)
class ParsedIdentifier:
    owner: str
    name: str
    version: Optional[str] = None


_DEFAULT_OWNER = "default"

# ``-`` is preserved verbatim as a LangSmith-compatible
# "current workspace owner" marker.
_IDENT_RE = re.compile(
    r"^(?:(?P<owner>[^/:\s\x00-\x1f]+)/)?"
    r"(?P<name>[^/:\s\x00-\x1f]+)"
    r"(?::(?P<version>[^/:\s\x00-\x1f]+))?$"
)


def parse_context_hub_identifier(
    identifier: str,
    *,
    version: Optional[str] = None,
) -> ParsedIdentifier:
    if not identifier:
        raise ValueError("identifier must not be empty")
    if any(ord(c) < 0x20 for c in identifier):
        raise ValueError(
            f"identifier contains control characters: {identifier!r}"
        )
    match = _IDENT_RE.match(identifier)
    if match is None:
        raise ValueError(f"invalid context hub identifier: {identifier!r}")
    owner = match.group("owner") or _DEFAULT_OWNER
    name = match.group("name")
    resolved_version = version if version is not None else match.group("version")
    return ParsedIdentifier(owner=owner, name=name, version=resolved_version)


_PARENT_COMMIT_RE = re.compile(r"^[0-9a-f]{8,64}$")


def is_valid_parent_commit(candidate: Optional[str]) -> bool:
    """``None`` or 8–64 lowercase hex digits."""
    if candidate is None:
        return True
    if not isinstance(candidate, str):
        return False
    return _PARENT_COMMIT_RE.fullmatch(candidate) is not None


def entry_to_mapping(entry: Entry) -> dict[str, Any]:
    if isinstance(entry, FileEntry):
        return {"type": "file", "content": entry.content}
    if isinstance(entry, (AgentEntry, SkillEntry)):
        out: dict[str, Any] = {
            "type": entry.type,
            "repo_handle": entry.repo_handle,
        }
        if entry.owner is not None:
            out["owner"] = entry.owner
        if entry.commit_id is not None:
            out["commit_id"] = entry.commit_id
        if entry.commit_hash is not None:
            out["commit_hash"] = entry.commit_hash
        return out
    raise TypeError(f"unsupported entry type: {type(entry).__name__}")


def entry_from_mapping(payload: Any) -> Entry:
    """Build an :data:`Entry` from a mapping, dataclass, or duck-typed object."""
    if isinstance(payload, (FileEntry, AgentEntry, SkillEntry)):
        return payload
    if isinstance(payload, Mapping):
        data: dict[str, Any] = dict(payload)
    else:
        type_value = getattr(payload, "type", None)
        if type_value is None:
            raise ValueError("entry has no 'type' attribute")
        data = {"type": type_value}
        if type_value == "file":
            data["content"] = getattr(payload, "content", "")
        else:
            for attr in ("repo_handle", "owner", "commit_id", "commit_hash"):
                if hasattr(payload, attr):
                    data[attr] = getattr(payload, attr)
    type_value = data.get("type")
    if type_value == "file":
        if "content" not in data:
            raise ValueError("file entry missing 'content'")
        return FileEntry(content=data["content"])
    if type_value in ("agent", "skill"):
        if "repo_handle" not in data:
            raise ValueError(f"{type_value} entry missing 'repo_handle'")
        kwargs = {
            "repo_handle": data["repo_handle"],
            "owner": data.get("owner"),
            "commit_id": data.get("commit_id"),
            "commit_hash": data.get("commit_hash"),
        }
        if type_value == "agent":
            return AgentEntry(**kwargs)
        return SkillEntry(**kwargs)
    raise ValueError(f"unsupported entry type: {type_value!r}")


__all__ = [
    "AgentContext",
    "AgentEntry",
    "Entry",
    "FileEntry",
    "ParsedIdentifier",
    "SkillContext",
    "SkillEntry",
    "entry_from_mapping",
    "entry_to_mapping",
    "is_valid_parent_commit",
    "parse_context_hub_identifier",
]

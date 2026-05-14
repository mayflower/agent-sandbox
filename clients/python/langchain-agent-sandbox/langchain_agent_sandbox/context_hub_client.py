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

"""Context Hub client protocol and shared exceptions."""

from __future__ import annotations

from typing import (
    Literal,
    Mapping,
    Optional,
    Protocol,
    runtime_checkable,
)
from collections.abc import Iterable

from .context_hub_models import (
    AgentContext,
    Entry,
    SkillContext,
    parse_context_hub_identifier,
)


class HubError(Exception):
    pass


class HubNotFoundError(HubError):
    pass


class HubConflictError(HubError):
    """``parent_commit`` did not match the current head."""


class HubValidationError(HubError):
    pass


class HubAuthError(HubError):
    pass


class HubRateLimitError(HubError):
    pass


@runtime_checkable
class ContextHubClientProtocol(Protocol):

    def push_agent(
        self,
        identifier: str,
        *,
        files: Mapping[str, Optional[Entry]],
        parent_commit: Optional[str] = None,
        description: Optional[str] = None,
        readme: Optional[str] = None,
        tags: Optional[Iterable[str]] = None,
        is_public: Optional[bool] = None,
    ) -> str: ...

    def push_skill(
        self,
        identifier: str,
        *,
        files: Mapping[str, Optional[Entry]],
        parent_commit: Optional[str] = None,
        description: Optional[str] = None,
        readme: Optional[str] = None,
        tags: Optional[Iterable[str]] = None,
        is_public: Optional[bool] = None,
    ) -> str: ...

    def pull_agent(
        self, identifier: str, *, version: Optional[str] = None
    ) -> AgentContext: ...

    def pull_skill(
        self, identifier: str, *, version: Optional[str] = None
    ) -> SkillContext: ...

    def agent_exists(self, identifier: str) -> bool: ...

    def skill_exists(self, identifier: str) -> bool: ...

    def delete_agent(self, identifier: str) -> None: ...

    def delete_skill(self, identifier: str) -> None: ...

    def list_agents(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        is_public: Optional[bool] = None,
        is_archived: Optional[bool] = False,
        query: Optional[str] = None,
    ) -> object: ...

    def list_skills(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        is_public: Optional[bool] = None,
        is_archived: Optional[bool] = False,
        query: Optional[str] = None,
    ) -> object: ...

    def tag_commit(
        self,
        identifier: str,
        tag: str,
        commit_hash: str,
        *,
        repo_type: Literal["agent", "skill"] = "agent",
    ) -> None: ...

    def promote(
        self,
        identifier: str,
        environment: str,
        commit_hash: str,
        *,
        repo_type: Literal["agent", "skill"] = "agent",
    ) -> None: ...


__all__ = [
    "ContextHubClientProtocol",
    "HubAuthError",
    "HubConflictError",
    "HubError",
    "HubNotFoundError",
    "HubRateLimitError",
    "HubValidationError",
    "parse_context_hub_identifier",
]

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

"""HTTP client implementing ``ContextHubClientProtocol``."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Literal, Mapping, Optional

import httpx

from .context_hub_client import (
    HubAuthError,
    HubConflictError,
    HubError,
    HubNotFoundError,
    HubRateLimitError,
    HubValidationError,
)
from .context_hub_models import (
    AgentContext,
    Entry,
    SkillContext,
    entry_from_mapping,
    entry_to_mapping,
    parse_context_hub_identifier,
)

_DEFAULT_TIMEOUT_SECONDS = 30.0


class ContextHubHttpClient:
    """Concrete :class:`ContextHubClientProtocol` over HTTP."""

    def __init__(
        self,
        base_url: str,
        *,
        api_key: Optional[str] = None,
        timeout: float = _DEFAULT_TIMEOUT_SECONDS,
        transport: Optional[httpx.BaseTransport] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        if not base_url:
            raise ValueError("base_url must not be empty")
        # Explicit ``client`` wins so callers can reuse a pooled
        # client with retry/auth middleware. Otherwise construct a new
        # one with an explicit timeout — httpx defaults to None
        # (no timeout) which is unsafe for a hub call.
        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            headers = {"accept": "application/json"}
            if api_key:
                headers["authorization"] = f"Bearer {api_key}"
            kwargs: dict[str, Any] = {
                "base_url": base_url.rstrip("/"),
                "timeout": timeout,
                "headers": headers,
            }
            if transport is not None:
                kwargs["transport"] = transport
            self._client = httpx.Client(**kwargs)
            self._owns_client = True
        self._base_url = base_url

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "ContextHubHttpClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

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
    ) -> str:
        return self._push(
            "agent",
            identifier,
            files=files,
            parent_commit=parent_commit,
            description=description,
            readme=readme,
            tags=tags,
            is_public=is_public,
        )

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
    ) -> str:
        return self._push(
            "skill",
            identifier,
            files=files,
            parent_commit=parent_commit,
            description=description,
            readme=readme,
            tags=tags,
            is_public=is_public,
        )

    def pull_agent(
        self, identifier: str, *, version: Optional[str] = None
    ) -> AgentContext:
        data = self._pull("agent", identifier, version=version)
        return AgentContext(
            files=_decode_files(data.get("files") or {}),
            commit_hash=data.get("commit_hash"),
            commit_id=data.get("commit_id"),
        )

    def pull_skill(
        self, identifier: str, *, version: Optional[str] = None
    ) -> SkillContext:
        data = self._pull("skill", identifier, version=version)
        return SkillContext(
            files=_decode_files(data.get("files") or {}),
            commit_hash=data.get("commit_hash"),
            commit_id=data.get("commit_id"),
        )

    def agent_exists(self, identifier: str) -> bool:
        return self._exists("agent", identifier)

    def skill_exists(self, identifier: str) -> bool:
        return self._exists("skill", identifier)

    def delete_agent(self, identifier: str) -> None:
        self._delete("agent", identifier)

    def delete_skill(self, identifier: str) -> None:
        self._delete("skill", identifier)

    def list_agents(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        is_public: Optional[bool] = None,
        is_archived: Optional[bool] = False,
        query: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._list(
            "agent",
            limit=limit,
            offset=offset,
            is_public=is_public,
            is_archived=is_archived,
            query=query,
        )

    def list_skills(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        is_public: Optional[bool] = None,
        is_archived: Optional[bool] = False,
        query: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._list(
            "skill",
            limit=limit,
            offset=offset,
            is_public=is_public,
            is_archived=is_archived,
            query=query,
        )

    def tag_commit(
        self,
        identifier: str,
        tag: str,
        commit_hash: str,
        *,
        repo_type: Literal["agent", "skill"] = "agent",
    ) -> None:
        parsed = parse_context_hub_identifier(identifier)
        response = self._client.put(
            f"/repos/{parsed.owner}/{parsed.name}/tags/{tag}",
            params={"repo_type": repo_type},
            json={"commit_hash": commit_hash},
        )
        self._raise_for_status(response)

    def promote(
        self,
        identifier: str,
        environment: str,
        commit_hash: str,
        *,
        repo_type: Literal["agent", "skill"] = "agent",
    ) -> None:
        parsed = parse_context_hub_identifier(identifier)
        response = self._client.post(
            f"/repos/{parsed.owner}/{parsed.name}/promotions/{environment}",
            params={"repo_type": repo_type},
            json={"commit_hash": commit_hash},
        )
        self._raise_for_status(response)

    def _push(
        self,
        repo_type: Literal["agent", "skill"],
        identifier: str,
        *,
        files: Mapping[str, Optional[Entry]],
        parent_commit: Optional[str],
        description: Optional[str],
        readme: Optional[str],
        tags: Optional[Iterable[str]],
        is_public: Optional[bool],
    ) -> str:
        parsed = parse_context_hub_identifier(identifier)
        payload: dict[str, Any] = {
            "parent_commit": parent_commit,
            "files": {
                path: (None if entry is None else entry_to_mapping(entry))
                for path, entry in files.items()
            },
        }
        if description is not None:
            payload["description"] = description
        if readme is not None:
            payload["readme"] = readme
        if tags is not None:
            payload["tags"] = list(tags)
        if is_public is not None:
            payload["is_public"] = is_public
        response = self._client.post(
            f"/v1/platform/hub/repos/{parsed.owner}/{parsed.name}/directories/commits",
            params={"repo_type": repo_type},
            json=payload,
        )
        self._raise_for_status(response)
        data = response.json()
        commit = data.get("commit") or {}
        commit_hash = commit.get("commit_hash")
        if not commit_hash:
            raise HubError(
                "server response did not include commit.commit_hash"
            )
        return f"{self._base_url.rstrip('/')}/{parsed.owner}/{parsed.name}:{commit_hash}"

    def _pull(
        self,
        repo_type: Literal["agent", "skill"],
        identifier: str,
        *,
        version: Optional[str],
    ) -> dict[str, Any]:
        parsed = parse_context_hub_identifier(identifier, version=version)
        params: dict[str, Any] = {"repo_type": repo_type}
        if parsed.version:
            params["commit"] = parsed.version
        response = self._client.get(
            f"/v1/platform/hub/repos/{parsed.owner}/{parsed.name}/directories",
            params=params,
        )
        self._raise_for_status(response)
        return response.json()

    def _exists(
        self, repo_type: Literal["agent", "skill"], identifier: str
    ) -> bool:
        parsed = parse_context_hub_identifier(identifier)
        response = self._client.get(
            f"/repos/{parsed.owner}/{parsed.name}",
            params={"repo_type": repo_type},
        )
        if response.status_code == 200:
            return True
        if response.status_code == 404:
            return False
        self._raise_for_status(response)
        return False  # unreachable

    def _delete(
        self, repo_type: Literal["agent", "skill"], identifier: str
    ) -> None:
        parsed = parse_context_hub_identifier(identifier)
        response = self._client.delete(
            f"/repos/{parsed.owner}/{parsed.name}",
            params={"repo_type": repo_type},
        )
        self._raise_for_status(response)

    def _list(
        self,
        repo_type: Literal["agent", "skill"],
        *,
        limit: int,
        offset: int,
        is_public: Optional[bool],
        is_archived: Optional[bool],
        query: Optional[str],
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "repo_type": repo_type,
            "limit": limit,
            "offset": offset,
        }
        if is_public is not None:
            params["is_public"] = "true" if is_public else "false"
        if is_archived is not None:
            params["is_archived"] = "true" if is_archived else "false"
        if query is not None:
            params["query"] = query
        response = self._client.get("/repos", params=params)
        self._raise_for_status(response)
        return response.json()

    def _raise_for_status(self, response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        message = _extract_message(response)
        if response.status_code == 404:
            raise HubNotFoundError(message)
        if response.status_code == 409:
            raise HubConflictError(message)
        if response.status_code in (401, 403):
            raise HubAuthError(message)
        if response.status_code == 422:
            raise HubValidationError(message)
        if response.status_code == 429:
            raise HubRateLimitError(message)
        raise HubError(
            f"context hub responded {response.status_code}: {message}"
        )


def _decode_files(
    payload: Mapping[str, Any],
) -> dict[str, Entry]:
    files: dict[str, Entry] = {}
    for path, entry in payload.items():
        files[path] = entry_from_mapping(entry)
    return files


def _extract_message(response: httpx.Response) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            return str(data.get("message") or data)
        return str(data)
    except Exception:
        return response.text or f"HTTP {response.status_code}"


__all__ = ["ContextHubHttpClient"]

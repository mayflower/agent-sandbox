"""In-memory Context Hub client used by adapter and integration tests.

Mirrors :class:`langchain_agent_sandbox.context_hub_client.ContextHubClientProtocol`
without any I/O. It stores per-commit snapshots so tag-based pulls
return historical content; ``parent_commit`` is validated so concurrency
contract tests exercise the same path the real HTTP client would.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from collections.abc import Iterable
from typing import Literal, Mapping

from langchain_agent_sandbox.context_hub_client import (
    HubConflictError,
    HubNotFoundError,
)
from langchain_agent_sandbox.context_hub_models import (
    AgentContext,
    Entry,
    SkillContext,
    parse_context_hub_identifier,
)


@dataclass
class _Repo:
    repo_type: Literal["agent", "skill"]
    files: dict[str, Entry] = field(default_factory=dict)
    commit_hash: str | None = None
    commit_id: str | None = None
    tags: dict[str, str] = field(default_factory=dict)
    description: str | None = None
    readme: str | None = None
    resource_tags: list[str] = field(default_factory=list)
    is_public: bool = False
    is_archived: bool = False
    snapshots: dict[str, dict[str, Entry]] = field(default_factory=dict)


class FakeContextHubClient:
    """In-memory implementation of the Context Hub client protocol."""

    def __init__(self) -> None:
        self.repos: dict[tuple[str, str], _Repo] = {}
        self.push_calls: list[dict] = []
        self.pull_calls: list[dict] = []
        self.fail_next_push: Exception | None = None
        self.fail_next_pull: Exception | None = None
        self._counter = 0

    def seed_agent(
        self,
        identifier: str,
        files: Mapping[str, Entry],
        commit_hash: str = "aaaaaaaa",
    ) -> None:
        self._seed("agent", identifier, files, commit_hash)

    def seed_skill(
        self,
        identifier: str,
        files: Mapping[str, Entry],
        commit_hash: str = "aaaaaaaa",
    ) -> None:
        self._seed("skill", identifier, files, commit_hash)

    def _seed(
        self,
        repo_type: Literal["agent", "skill"],
        identifier: str,
        files: Mapping[str, Entry],
        commit_hash: str,
    ) -> None:
        parsed = parse_context_hub_identifier(identifier)
        snapshot = dict(files)
        repo = _Repo(
            repo_type=repo_type,
            files=snapshot,
            commit_hash=commit_hash,
            commit_id=f"commit-{commit_hash}",
        )
        repo.snapshots[commit_hash] = dict(snapshot)
        self.repos[(repo_type, f"{parsed.owner}/{parsed.name}")] = repo

    def push_agent(
        self,
        identifier: str,
        *,
        files: Mapping[str, Entry | None],
        parent_commit: str | None = None,
        description: str | None = None,
        readme: str | None = None,
        tags: Iterable[str] | None = None,
        is_public: bool | None = None,
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
        files: Mapping[str, Entry | None],
        parent_commit: str | None = None,
        description: str | None = None,
        readme: str | None = None,
        tags: Iterable[str] | None = None,
        is_public: bool | None = None,
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
        self, identifier: str, *, version: str | None = None
    ) -> AgentContext:
        repo, snapshot = self._pull("agent", identifier, version=version)
        return AgentContext(
            files=dict(snapshot),
            commit_hash=repo.commit_hash,
            commit_id=repo.commit_id,
        )

    def pull_skill(
        self, identifier: str, *, version: str | None = None
    ) -> SkillContext:
        repo, snapshot = self._pull("skill", identifier, version=version)
        return SkillContext(
            files=dict(snapshot),
            commit_hash=repo.commit_hash,
            commit_id=repo.commit_id,
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
        is_public: bool | None = None,
        is_archived: bool | None = False,
        query: str | None = None,
    ) -> dict:
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
        is_public: bool | None = None,
        is_archived: bool | None = False,
        query: str | None = None,
    ) -> dict:
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
        repo = self._get(repo_type, identifier)
        repo.tags[tag] = commit_hash

    def promote(
        self,
        identifier: str,
        environment: str,
        commit_hash: str,
        *,
        repo_type: Literal["agent", "skill"] = "agent",
    ) -> None:
        self.tag_commit(identifier, environment, commit_hash, repo_type=repo_type)

    def _push(
        self,
        repo_type: Literal["agent", "skill"],
        identifier: str,
        *,
        files: Mapping[str, Entry | None],
        parent_commit: str | None,
        description: str | None,
        readme: str | None,
        tags: Iterable[str] | None,
        is_public: bool | None,
    ) -> str:
        if self.fail_next_push is not None:
            exc = self.fail_next_push
            self.fail_next_push = None
            raise exc
        parsed = parse_context_hub_identifier(identifier)
        key = (repo_type, f"{parsed.owner}/{parsed.name}")
        repo = self.repos.get(key)
        if repo is None:
            repo = _Repo(repo_type=repo_type)
            self.repos[key] = repo
        if (
            parent_commit is not None
            and repo.commit_hash is not None
            and parent_commit != repo.commit_hash
        ):
            raise HubConflictError(
                f"parent_commit {parent_commit} != head {repo.commit_hash}"
            )
        for path, entry in files.items():
            if entry is None:
                repo.files.pop(path, None)
            else:
                repo.files[path] = entry
        self._counter += 1
        repo.commit_hash = f"{self._counter:08x}"
        repo.commit_id = f"commit-{repo.commit_hash}"
        repo.snapshots[repo.commit_hash] = dict(repo.files)
        if description is not None:
            repo.description = description
        if readme is not None:
            repo.readme = readme
        if tags is not None:
            repo.resource_tags = list(tags)
        if is_public is not None:
            repo.is_public = is_public
        call = {
            "repo_type": repo_type,
            "identifier": identifier,
            "files": dict(files),
            "parent_commit": parent_commit,
            "commit_hash": repo.commit_hash,
        }
        self.push_calls.append(call)
        return (
            f"https://context-hub.local/{parsed.owner}/{parsed.name}:"
            f"{repo.commit_hash}"
        )

    def _pull(
        self,
        repo_type: Literal["agent", "skill"],
        identifier: str,
        *,
        version: str | None,
    ) -> tuple[_Repo, dict[str, Entry]]:
        if self.fail_next_pull is not None:
            exc = self.fail_next_pull
            self.fail_next_pull = None
            raise exc
        parsed = parse_context_hub_identifier(identifier, version=version)
        repo = self._get(repo_type, f"{parsed.owner}/{parsed.name}")
        resolved_version = parsed.version
        if resolved_version:
            tag_hash = repo.tags.get(resolved_version)
            if tag_hash is not None:
                snapshot = repo.snapshots.get(tag_hash)
                if snapshot is None:
                    raise HubNotFoundError(
                        f"snapshot for tag {resolved_version} not found"
                    )
                self.pull_calls.append(
                    {
                        "repo_type": repo_type,
                        "identifier": identifier,
                        "version": version,
                    }
                )
                return repo, snapshot
            if resolved_version == repo.commit_hash:
                self.pull_calls.append(
                    {
                        "repo_type": repo_type,
                        "identifier": identifier,
                        "version": version,
                    }
                )
                return repo, repo.files
            snapshot = repo.snapshots.get(resolved_version)
            if snapshot is None:
                raise HubNotFoundError(
                    f"version {resolved_version} not found"
                )
            self.pull_calls.append(
                {
                    "repo_type": repo_type,
                    "identifier": identifier,
                    "version": version,
                }
            )
            return repo, snapshot
        self.pull_calls.append(
            {
                "repo_type": repo_type,
                "identifier": identifier,
                "version": version,
            }
        )
        return repo, repo.files

    def _get(
        self, repo_type: Literal["agent", "skill"], identifier: str
    ) -> _Repo:
        parsed = parse_context_hub_identifier(identifier)
        key = (repo_type, f"{parsed.owner}/{parsed.name}")
        repo = self.repos.get(key)
        if repo is None:
            raise HubNotFoundError(
                f"{repo_type} repo not found: {parsed.owner}/{parsed.name}"
            )
        return repo

    def _exists(
        self, repo_type: Literal["agent", "skill"], identifier: str
    ) -> bool:
        parsed = parse_context_hub_identifier(identifier)
        return (repo_type, f"{parsed.owner}/{parsed.name}") in self.repos

    def _delete(
        self, repo_type: Literal["agent", "skill"], identifier: str
    ) -> None:
        parsed = parse_context_hub_identifier(identifier)
        self.repos.pop((repo_type, f"{parsed.owner}/{parsed.name}"), None)

    def _list(
        self,
        repo_type: Literal["agent", "skill"],
        *,
        limit: int,
        offset: int,
        is_public: bool | None,
        is_archived: bool | None,
        query: str | None,
    ) -> dict:
        rows: list[dict] = []
        for (typ, full_name), repo in self.repos.items():
            if typ != repo_type:
                continue
            if is_public is not None and repo.is_public != is_public:
                continue
            if is_archived is not None and repo.is_archived != is_archived:
                continue
            if query and (
                query not in full_name
                and query not in (repo.description or "")
                and query not in " ".join(repo.resource_tags)
            ):
                continue
            owner, handle = full_name.split("/", 1)
            rows.append(
                {
                    "owner": owner,
                    "repo_handle": handle,
                    "repo_type": typ,
                    "commit_hash": repo.commit_hash,
                }
            )
        return {
            "repos": rows[offset : offset + limit],
            "limit": limit,
            "offset": offset,
            "total": len(rows),
        }

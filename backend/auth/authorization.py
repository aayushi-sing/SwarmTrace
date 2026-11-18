"""Shared project/trace authorization for HTTP, ingestion and live subscriptions."""
from uuid import UUID

from database import get_pool
from fastapi import Depends, HTTPException

from auth.dependencies import require_auth

LEVELS = {"viewer": 0, "developer": 1, "admin": 2}


def project_uuid(value):
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise HTTPException(status_code=404, detail="Project not found") from error


async def accessible_projects(user, minimum="viewer"):
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT project_id, role FROM project_members WHERE user_id = $1",
            project_uuid(user["user_id"]),
        )
    return [row["project_id"] for row in rows
            if LEVELS.get(row["role"], -1) >= LEVELS[minimum]
            and (not user.get("api_key") or str(row["project_id"]) == user.get("project_id"))]


async def authorize_project(project_id, user, minimum="viewer"):
    project_id = project_uuid(project_id)
    if project_id not in await accessible_projects(user, minimum):
        raise HTTPException(status_code=404, detail="Project not found")
    return project_id


async def project_scope(project_id: str | None = None, user: dict = Depends(require_auth)):  # noqa: B008
    projects = await accessible_projects(user)
    if project_id is not None:
        requested = project_uuid(project_id)
        if requested not in projects:
            raise HTTPException(status_code=404, detail="Project not found")
        projects = [requested]
    return projects


async def authorize_trace(trace_id, user, minimum="viewer"):
    projects = await accessible_projects(user, minimum)
    pool = await get_pool()
    async with pool.acquire() as conn:
        trace = await conn.fetchrow(
            "SELECT * FROM traces WHERE trace_id = $1 AND project_id = ANY($2::uuid[])",
            trace_id, projects,
        )
    if trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return dict(trace)


async def readable_trace(trace_id: str, user: dict = Depends(require_auth)):  # noqa: B008
    return await authorize_trace(trace_id, user)


async def writable_trace(trace_id: str, user: dict = Depends(require_auth)):  # noqa: B008
    return await authorize_trace(trace_id, user, "developer")

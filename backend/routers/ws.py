"""Authenticated live subscriptions. Credentials travel in the first frame, never URLs.

Client: {"type":"AUTH","token":<JWT>}; server: {"type":"AUTHENTICATED"}.
No trace events are sent before authentication and subscription authorization.
"""
import asyncio
import json
from collections import defaultdict
from uuid import UUID

from auth.authorization import accessible_projects, authorize_project, authorize_trace
from auth.utils import decode_token
from database import get_pool
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from jose import JWTError

router = APIRouter()
_trace_list_clients = {}
_trace_detail_clients = defaultdict(dict)


def _identity(token):
    try:
        if not isinstance(token, str):
            raise HTTPException(status_code=401)
        payload = decode_token(token)
        return {"user_id": str(UUID(payload["sub"])), "email": payload["email"]}
    except (JWTError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from error


async def _validate(subscription, trace_id=None):
    user = _identity(subscription["token"])
    if trace_id is not None:
        trace = await authorize_trace(trace_id, user)
        return [trace["project_id"]]
    if subscription["project_id"] is not None:
        return [await authorize_project(subscription["project_id"], user)]
    return await accessible_projects(user)


async def _subscribe(websocket, trace_id=None):
    await websocket.accept()
    clients = None
    try:
        message = await asyncio.wait_for(websocket.receive_json(), timeout=5)
        if not isinstance(message, dict) or message.get("type") != "AUTH":
            raise HTTPException(status_code=401)
        subscription = {"token": message.get("token"), "project_id": websocket.query_params.get("project_id")}
        await _validate(subscription, trace_id)
        clients = _trace_detail_clients[trace_id] if trace_id is not None else _trace_list_clients
        clients[websocket] = subscription
        await websocket.send_json({"type": "AUTHENTICATED"})
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
            except TimeoutError:
                pass
            # Expiry and membership revocation close even idle connections.
            await _validate(subscription, trace_id)
    except HTTPException as error:
        await websocket.close(code=4401 if error.status_code == 401 else 4403)
    except (ValueError, TypeError, TimeoutError):
        await websocket.close(code=4401)
    except WebSocketDisconnect:
        pass
    finally:
        if clients is not None:
            clients.pop(websocket, None)
        if trace_id is not None and not _trace_detail_clients.get(trace_id):
            _trace_detail_clients.pop(trace_id, None)


@router.websocket("/ws/traces")
async def ws_traces(websocket: WebSocket):
    await _subscribe(websocket)


@router.websocket("/ws/trace/{trace_id}")
async def ws_trace_detail(websocket: WebSocket, trace_id: str):
    await _subscribe(websocket, trace_id)


async def _broadcast(clients, trace_id, payload, detail=False):
    if not clients:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        project = await conn.fetchval("SELECT project_id FROM traces WHERE trace_id=$1", trace_id)
    if project is None:
        return
    for socket, subscription in list(clients.items()):
        try:
            projects = await _validate(subscription, trace_id if detail else None)
            if project in projects:
                await socket.send_text(json.dumps(payload))
        except HTTPException as error:
            clients.pop(socket, None)
            await socket.close(code=4401 if error.status_code == 401 else 4403)
        except Exception:  # noqa: BLE001 -- stale/disconnected sockets are removed, never sent data
            clients.pop(socket, None)


async def broadcast_trace_update(trace_id: str, status: str, root_agent: str):
    await _broadcast(_trace_list_clients, trace_id, {
        "type": "TRACE_UPDATE", "trace_id": trace_id, "status": status, "root_agent": root_agent,
    })


async def broadcast_span(trace_id: str, span: dict):
    await _broadcast(_trace_detail_clients.get(trace_id, {}), trace_id, {
        "type": "NEW_SPAN", "span": span,
    }, detail=True)

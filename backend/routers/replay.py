"""Fork saved workflow state without changing historical trace records."""
import logging
import uuid

from auth.authorization import authorize_trace
from auth.dependencies import require_auth
from database import get_pool
from fastapi import APIRouter, Depends, HTTPException
from models import ReplayRequest
from replay_support import ReplayExecutionError, persist_recording, prepare_state

from routers.audit import log_action
from routers.ws import broadcast_span, broadcast_trace_update

router = APIRouter()
logger = logging.getLogger(__name__)


async def _publish(trace_id, root_agent, spans, status):
    # Publishing is best-effort after commit; it must never undo a durable replay.
    try:
        for span in spans:
            await broadcast_span(trace_id, span)
        await broadcast_trace_update(trace_id, status, root_agent)
    except Exception:  # noqa: BLE001 -- preserve durable work on external failure
        logger.warning('Replay committed but live notification failed for %s', trace_id)


@router.post('/replay')
async def replay(request: ReplayRequest, user: dict = Depends(require_auth)):  # noqa: B008
    await authorize_trace(request.trace_id, user, "developer")
    pool = await get_pool()
    async with pool.acquire() as conn:
        snapshot = await conn.fetchrow('''
            SELECT * FROM state_snapshots WHERE trace_id=$1 AND step_number=$2
            ORDER BY created_at DESC LIMIT 1
        ''', request.trace_id, request.step_number)
        if not snapshot:
            raise HTTPException(status_code=404, detail=f'No snapshot found at step {request.step_number} for trace {request.trace_id}')
        try:
            state_data, normalized, mode = prepare_state(snapshot['state_data'], request.overrides, request.step_number)
        except (ValueError, TypeError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        source = await conn.fetchrow('SELECT project_id FROM traces WHERE trace_id=$1', request.trace_id)
        if not source:
            raise HTTPException(status_code=404, detail='Source trace not found')
        project_id = source['project_id']
        new_trace_id = uuid.uuid4().hex
        await conn.execute('''
            INSERT INTO traces (trace_id, project_id, root_agent, status, parent_trace_id)
            VALUES ($1,$2,$3,'RUNNING',$4)
        ''', new_trace_id, project_id, snapshot['agent_name'], request.trace_id)

    from agents.orchestrator import resume_from_snapshot
    try:
        recording = await resume_from_snapshot(
            new_trace_id=new_trace_id, state_data=state_data, from_step=request.step_number,
            source_trace_id=request.trace_id, source_span_id=snapshot['span_id'],
            replay_mode=mode, override_fields=tuple(normalized),
        )
        spans = await persist_recording(pool, recording)
    except Exception as error:
        # Preserve completed work on an execution failure, without claiming SUCCESS.
        try:
            if isinstance(error, ReplayExecutionError) and error.recording.spans:
                partial = await persist_recording(pool, error.recording, status='FAILED')
                await _publish(new_trace_id, snapshot['agent_name'], partial, 'FAILED')
            else:
                async with pool.acquire() as conn:
                    await conn.execute("UPDATE traces SET status='FAILED' WHERE trace_id=$1 AND status='RUNNING'", new_trace_id)
        except Exception:  # noqa: BLE001 -- preserve durable work on external failure
            async with pool.acquire() as conn:
                await conn.execute("UPDATE traces SET status='FAILED' WHERE trace_id=$1 AND status='RUNNING'", new_trace_id)
        raise HTTPException(status_code=500, detail=f'Replay failed; fork {new_trace_id} is marked FAILED.') from error

    await _publish(new_trace_id, snapshot['agent_name'], spans, 'SUCCESS')
    await log_action(
        project_id=project_id, user_id=user['user_id'], user_email=user['email'],
        action='TRACE_REPLAY', resource_type='trace', resource_id=new_trace_id,
        metadata={'original_trace_id': request.trace_id, 'source_span_id': snapshot['span_id'],
                  'step_number': request.step_number, 'overrides_keys': list(normalized),
                  'replay_mode': mode},
    )
    return {'status': 'ok', 'original_trace_id': request.trace_id,
            'forked_trace_id': new_trace_id, 'forked_from_step': request.step_number}

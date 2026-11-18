"""Replay state normalization and atomic persistence. No changes to source traces."""
from copy import deepcopy
import json

from routers.ingest import _calculate_cost

STEPS = {1: ('researcher', 'findings'), 2: ('writer', 'article'), 3: ('critic', 'critique')}


class ReplayExecutionError(RuntimeError):
    def __init__(self, recording, cause):
        super().__init__('Replay agent execution failed')
        self.recording = recording
        self.cause = cause


def prepare_state(snapshot_state, overrides, step):
    if step not in STEPS:
        raise ValueError('Replay step must be 1, 2, or 3')
    state = json.loads(snapshot_state) if isinstance(snapshot_state, str) else deepcopy(snapshot_state)
    if not isinstance(state, dict):
        raise ValueError('Saved replay state must be an object')
    normalized = deepcopy(overrides)
    field = STEPS[step][1]
    if 'raw' in normalized:
        raw = normalized.pop('raw')
        if not isinstance(raw, str):
            raise ValueError('Plain-text replay override must be a string')
        # An explicit structured field wins when both representations are supplied.
        normalized.setdefault(field, raw)
    mode = 'overridden' if field in normalized and normalized[field] != state.get(field) else 'reused'
    state.update(normalized)
    if field not in state:
        raise ValueError(f'Saved state or override must provide {field}')
    return state, normalized, mode


def validate_recording(recording):
    spans = recording.spans
    by_id = {span['span_id']: span for span in spans}
    if not spans or len(by_id) != len(spans):
        raise ValueError('Replay must have unique recorded spans')
    roots = [span for span in spans if span.get('parent_span_id') is None]
    if len(roots) != 1 or roots[0]['span_type'] != 'REPLAY_INPUT':
        raise ValueError('Replay must have one explicit replay-input boundary')
    ordered = []
    remaining = list(spans)
    seen = set()
    while remaining:
        ready = [span for span in remaining if span.get('parent_span_id') is None or span['parent_span_id'] in seen]
        if not ready:
            raise ValueError('Replay contains a missing parent or cyclic relationship')
        for span in ready:
            if span['trace_id'] != recording.trace_id:
                raise ValueError('Replay span belongs to another trace')
            ordered.append(span)
            seen.add(span['span_id'])
            remaining.remove(span)
    for snapshot in recording.snapshots:
        if snapshot['trace_id'] != recording.trace_id or snapshot['span_id'] not in seen:
            raise ValueError('Replay snapshot has no span in the fork')
    return ordered


async def persist_recording(pool, recording, status='SUCCESS'):
    """Commit spans, checkpoints and computed totals together, exactly once per fork."""
    spans = validate_recording(recording)
    persisted = []
    async with pool.acquire() as conn:
        async with conn.transaction():
            trace = await conn.fetchrow('SELECT status FROM traces WHERE trace_id = $1 FOR UPDATE', recording.trace_id)
            if not trace or trace['status'] != 'RUNNING':
                raise ValueError('Replay trace is missing or already finalized')
            for span in spans:
                cost = _calculate_cost(span.get('token_usage'))
                await conn.execute('''
                    INSERT INTO spans (span_id, trace_id, parent_span_id, agent_name,
                        span_type, input_payload, output_payload, latency_ms, token_usage,
                        estimated_cost_usd, created_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())
                ''', span['span_id'], recording.trace_id, span.get('parent_span_id'),
                    span['agent_name'], span['span_type'], json.dumps(span['input_payload']),
                    json.dumps(span['output_payload']), span['latency_ms'],
                    json.dumps(span['token_usage']) if span.get('token_usage') is not None else None, cost)
                persisted.append({**span, 'estimated_cost_usd': cost, 'children': []})
            for snapshot in recording.snapshots:
                await conn.execute('''
                    INSERT INTO state_snapshots (trace_id, span_id, step_number, agent_name, state_data, created_at)
                    VALUES ($1,$2,$3,$4,$5,clock_timestamp())
                ''', recording.trace_id, snapshot['span_id'], snapshot['step_number'],
                    snapshot['agent_name'], json.dumps(snapshot['state_data']))
            # This update sees every span inserted above, in the same transaction.
            await conn.execute('''
                UPDATE traces SET status = $2,
                    total_latency_ms = (SELECT COALESCE(SUM(latency_ms),0) FROM spans WHERE trace_id=$1),
                    total_cost_usd = (SELECT COALESCE(SUM(estimated_cost_usd),0) FROM spans WHERE trace_id=$1)
                WHERE trace_id = $1
            ''', recording.trace_id, status)
    return persisted

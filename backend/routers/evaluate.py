"""Role-specific, append-only trace evaluations using versioned feedback metadata."""
import json
import os
import uuid

from auth.authorization import readable_trace, writable_trace
from database import get_pool
from evaluation import (
    FEEDBACK_PREFIX,
    AssessmentUnavailable,
    content_prompt,
    orchestration_assessment,
    parsed_scores,
    versioned_feedback,
)
from fastapi import APIRouter, Depends, HTTPException
from groq import Groq
from starlette.concurrency import run_in_threadpool

router = APIRouter()
_JUDGE_MODEL = 'qwen/qwen3.8-27b'
_PASS_THRESHOLD = 6.0


def _get_groq_client():
    return Groq(api_key=os.getenv('GROQ_API_KEY'))


def _parse_judge_response(text):
    text = text.strip()
    if text.startswith('```'):
        text = '\n'.join(text.splitlines()[1:-1])
    scores = json.loads(text)
    if not isinstance(scores, dict):
        raise AssessmentUnavailable('Judge response was not a score object.')
    return scores


@router.post('/evaluate/{trace_id}')
async def evaluate_trace(trace_id: str, authorized: dict = Depends(writable_trace)):  # noqa: B008
    """Append current-rubric assessments, preserving every historical record.

    Only completed PASS/FAIL assessments for this rubric suppress another run.
    ERROR rows are never modified or removed; retries append a new assessment.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        trace = await conn.fetchrow('SELECT * FROM traces WHERE trace_id = $1', trace_id)
        if not trace:
            raise HTTPException(status_code=404, detail='Trace not found')
        all_spans = await conn.fetch('SELECT * FROM spans WHERE trace_id = $1 ORDER BY created_at ASC', trace_id)
        completed = await conn.fetch(
            """SELECT span_id FROM evaluations
               WHERE trace_id = $1 AND verdict IN ('PASS', 'FAIL') AND feedback LIKE $2""",
            trace_id, FEEDBACK_PREFIX + '%',
        )
    completed_ids = {row['span_id'] for row in completed}
    spans = [span for span in all_spans if span['span_type'] == 'AGENT_REASONING' and span['span_id'] not in completed_ids]
    if not spans:
        return {'status': 'ok', 'message': 'No spans to evaluate (current rubric complete or none exist)'}

    results = []
    client = None
    for span in spans:
        role = span['agent_name'].lower()
        method = 'deterministic' if role == 'orchestrator' else 'llm'
        model = 'deterministic:orchestrator-v2' if role == 'orchestrator' else _JUDGE_MODEL
        values = {'relevance': None, 'reasoning': None, 'quality': None}
        overall = None
        context = None
        try:
            if role == 'orchestrator':
                values, overall, verdict, feedback = orchestration_assessment(dict(trace), dict(span), all_spans)
            else:
                prompt, context = content_prompt(span)
                if client is None:
                    client = _get_groq_client()
                response = await run_in_threadpool(
                    client.chat.completions.create,
                    model=_JUDGE_MODEL,
                    messages=[{'role': 'user', 'content': prompt}],
                    temperature=0.1,
                    max_tokens=1200,
                )
                if getattr(response.choices[0], 'finish_reason', None) == 'length':
                    raise AssessmentUnavailable('Judge response exceeded its generation budget. No agent score assigned.')
                scores = _parse_judge_response(response.choices[0].message.content)
                values, overall, summary, unavailable = parsed_scores(scores)
                verdict = 'ERROR' if overall is None else 'PASS' if overall >= _PASS_THRESHOLD else 'FAIL'
                feedback = versioned_feedback(role, method, summary, context=context, unavailable=unavailable)
        except Exception as error:  # noqa: BLE001 -- A judge failure must not manufacture zero scores.
            values = {'relevance': None, 'reasoning': None, 'quality': None}
            overall = None
            verdict = 'ERROR'
            summary = str(error) if isinstance(error, AssessmentUnavailable) else f'Judge assessment unavailable ({type(error).__name__}). No agent score assigned.'
            feedback = versioned_feedback(role, method, summary, context=context, unavailable=[summary])

        async with pool.acquire() as conn:  # noqa: SIM117 -- transaction follows explanatory lock comment
            # A per-span lock also prevents concurrent requests duplicating a completed
            # assessment. This uses existing PostgreSQL facilities, not a schema change.
            async with conn.transaction():
                await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', f'evaluation:{trace_id}:{span["span_id"]}')
                already_done = await conn.fetchval(
                    """SELECT EXISTS(SELECT 1 FROM evaluations WHERE trace_id = $1 AND span_id = $2
                       AND verdict IN ('PASS', 'FAIL') AND feedback LIKE $3)""",
                    trace_id, span['span_id'], FEEDBACK_PREFIX + '%',
                )
                if already_done:
                    continue
                await conn.execute(
                    """INSERT INTO evaluations
                       (eval_id, trace_id, span_id, judge_model, relevance, reasoning, quality, overall, verdict, feedback)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
                    str(uuid.uuid4()), trace_id, span['span_id'], model,
                    values['relevance'], values['reasoning'], values['quality'], overall, verdict, feedback,
                )
        results.append({'span_id': span['span_id'], 'agent_name': span['agent_name'], 'overall': overall, 'verdict': verdict, 'feedback': feedback})
    return {'status': 'ok', 'trace_id': trace_id, 'evaluated': len(results), 'results': results}


@router.get('/evaluations/{trace_id}')
async def get_evaluations(trace_id: str, authorized: dict = Depends(readable_trace)):  # noqa: B008
    """Return all historical and current assessments using the existing response fields."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT e.eval_id, e.span_id, e.judge_model,
                      e.relevance, e.reasoning, e.quality, e.overall, e.verdict,
                      e.feedback, e.created_at, s.agent_name, s.span_type
               FROM evaluations e JOIN spans s ON s.span_id = e.span_id
               WHERE e.trace_id = $1 ORDER BY e.created_at ASC, e.eval_id ASC""",
            trace_id,
        )
    return [dict(row) for row in rows]

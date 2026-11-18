"""Replay correctness tests; model and database I/O are isolated fixtures."""
import asyncio
from copy import deepcopy
from decimal import Decimal
import importlib
import json
import os
import threading
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from replay_support import (ReplayExecutionError, persist_recording, prepare_state, validate_recording)
from tracing.otel_setup import Span, ReplayCapture, capture_replay, emit_spans, is_replay_capture
from agents.orchestrator import resume_from_snapshot


def test_plain_text_override_maps_to_selected_step():
    for step,field in ((1,'findings'),(2,'article'),(3,'critique')):
        original={'topic':'Test',field:'Original'}
        state,normalized,mode=prepare_state(original,{'raw':'Replacement'},step)
        assert state[field]=='Replacement'
        assert normalized=={field:'Replacement'}
        assert mode=='overridden'
        assert original[field]=='Original'


def test_json_overrides_preserve_structure_and_explicit_field_wins():
    original={'topic':'Original topic','findings':'Original findings'}
    overrides={'findings':{'facts':['one','two']},'topic':'New topic','options':{'nested':True}}
    state,normalized,mode=prepare_state(json.dumps(original),overrides,1)
    assert normalized==overrides
    assert state['findings']=={'facts':['one','two']}
    assert state['options']=={'nested':True}
    assert mode=='overridden'
    state,_,_=prepare_state(original,{'raw':'Fallback','findings':'Explicit'},1)
    assert state['findings']=='Explicit'
    assert original['findings']=='Original findings'


def test_unchanged_output_is_reused_and_invalid_overrides_are_rejected():
    assert prepare_state({'findings':'same'},{'findings':'same'},1)[2]=='reused'
    for state,overrides,step in (({}, {}, 1), ({'findings':'a'},{'raw':[]},1), ({'findings':'a'},{},99)):
        with pytest.raises(ValueError): prepare_state(state,overrides,step)


def agent_modules():
    # Importing a client needs a key value, but all invocations below are mocked.
    with patch.dict(os.environ,{'GROQ_API_KEY':'test-only-no-network'}):
        return importlib.import_module('agents.writer'),importlib.import_module('agents.critic')


def response(text):
    result=MagicMock()
    result.content=text
    result.response_metadata={'token_usage':{'prompt_tokens':11,'completion_tokens':7}}
    return result


@contextmanager
def patch_invoke(module, **kwargs):
    invoke = MagicMock(**kwargs)
    with patch.object(module, 'llm', SimpleNamespace(invoke=invoke)):
        yield invoke


@pytest.mark.asyncio
async def test_resume_records_boundary_and_parent_chain_without_self_http():
    writer,critic=agent_modules()
    main_thread=threading.get_ident()
    calls=[]
    def write(messages):
        calls.append(threading.get_ident())
        assert 'Overridden findings' in messages[1]['content']
        return response('New article')
    with patch_invoke(writer,side_effect=write),patch_invoke(critic,return_value=response('New critique')),patch('tracing.otel_setup.httpx.post') as post,patch('agents.critic.httpx.patch') as complete:
        recording=await resume_from_snapshot('fresh-fork',{'topic':'Topic','findings':'Overridden findings'},1,source_trace_id='source',source_span_id='source-research',replay_mode='overridden',override_fields=('findings',))
    post.assert_not_called()
    complete.assert_not_called()
    assert calls and all(thread!=main_thread for thread in calls)
    spans=validate_recording(recording)
    assert [span['span_type'] for span in spans]==['REPLAY_INPUT','HANDOFF','AGENT_REASONING','HANDOFF','AGENT_REASONING']
    assert not any(span['agent_name']=='researcher' and span['span_type']=='AGENT_REASONING' for span in spans)
    boundary=spans[0]
    assert boundary['parent_span_id'] is None
    assert boundary['input_payload']['replay']=={'source_trace_id':'source','source_span_id':'source-research','step_number':1,'mode':'overridden','model_executed':False,'override_fields':['findings']}
    assert boundary['output_payload']=={'findings':'Overridden findings'}
    assert boundary['token_usage'] is None and boundary['latency_ms']==0
    assert recording.snapshots[0]['state_data']['findings']=='Overridden findings'
    known=set()
    for span in spans:
        assert span['trace_id']=='fresh-fork'
        assert span['parent_span_id'] is None or span['parent_span_id'] in known
        known.add(span['span_id'])
    assert not is_replay_capture('fresh-fork')


@pytest.mark.asyncio
async def test_writer_and_critic_boundaries_do_not_rerun_selected_agent():
    writer,critic=agent_modules()
    with patch_invoke(writer) as write,patch_invoke(critic,return_value=response('Critique')) as critique,patch('tracing.otel_setup.httpx.post'),patch('agents.critic.httpx.patch') as complete:
        recording=await resume_from_snapshot('fork-two',{'topic':'Topic','article':'Edited article'},2)
        assert len(recording.spans)==3
        assert recording.spans[0]['agent_name']=='writer'
        assert recording.spans[0]['output_payload']=={'article':'Edited article'}
        write.assert_not_called()
        assert 'Edited article' in critique.call_args.args[0][1]['content']
        complete.assert_not_called()
        critique.reset_mock()
        terminal=await resume_from_snapshot('fork-three',{'topic':'Topic','critique':'Edited critique'},3)
        assert len(terminal.spans)==1 and terminal.spans[0]['span_type']=='REPLAY_INPUT'
        critique.assert_not_called()


@pytest.mark.asyncio
async def test_concurrent_replay_buffers_are_isolated():
    writer,critic=agent_modules()
    with patch_invoke(writer,return_value=response('Article')),patch_invoke(critic,return_value=response('Critique')),patch('tracing.otel_setup.httpx.post'),patch('agents.critic.httpx.patch'):
        a,b=await asyncio.gather(resume_from_snapshot('fork-a',{'findings':'A'},1),resume_from_snapshot('fork-b',{'findings':'B'},1))
    assert {span['trace_id'] for span in a.spans}=={'fork-a'}
    assert {span['trace_id'] for span in b.spans}=={'fork-b'}
    assert not ({span['span_id'] for span in a.spans}&{span['span_id'] for span in b.spans})
    assert a.spans[0]['output_payload']=={'findings':'A'}
    assert b.spans[0]['output_payload']=={'findings':'B'}


@pytest.mark.asyncio
async def test_failure_retains_completed_boundary_and_resets_capture():
    writer,_=agent_modules()
    with patch_invoke(writer,side_effect=RuntimeError('Model failed')),patch('tracing.otel_setup.httpx.post') as post:
        with pytest.raises(ReplayExecutionError) as captured:
            await resume_from_snapshot('failed-fork',{'findings':'Source'},1)
    assert len(validate_recording(captured.value.recording))==2
    assert not is_replay_capture('failed-fork')
    post.assert_not_called()


def sample_recording():
    recording=ReplayCapture('fork')
    boundary=Span('fork','researcher','REPLAY_INPUT',{'replay':{'model_executed':False}})
    boundary.end({'findings':'Data'})
    boundary.latency_ms=0
    model=Span('fork','writer','AGENT_REASONING',{},parent_span_id=boundary.span_id)
    model.end({'article':'Article'},{'prompt_tokens':100,'completion_tokens':200})
    model.latency_ms=123
    recording.record([boundary,model],[{'trace_id':'fork','span_id':boundary.span_id,'step_number':1,'agent_name':'researcher','state_data':{'findings':'Data'}}])
    return recording


def test_capture_deduplicates_identical_emissions_and_rejects_conflicts():
    span=Span('fork','researcher','REPLAY_INPUT',{})
    with capture_replay('fork') as recording:
        emit_spans([span]);emit_spans([span])
        assert len(recording.spans)==1
        span.output_payload={'different':True}
        with pytest.raises(ValueError):emit_spans([span])
    with capture_replay('fork'):
        with pytest.raises(ValueError):emit_spans([Span('another','writer','AGENT_REASONING',{})])


def test_orphan_cross_trace_and_cycle_are_rejected_before_persistence():
    for mutation in ('orphan','trace','cycle'):
        recording=sample_recording()
        if mutation=='orphan':recording.spans[1]['parent_span_id']='missing'
        elif mutation=='trace':recording.spans[1]['trace_id']='original'
        else:recording.spans[1]['parent_span_id']=recording.spans[1]['span_id']
        with pytest.raises(ValueError):validate_recording(recording)


class Transaction:
    def __init__(self,connection):self.connection=connection
    async def __aenter__(self):
        self.saved=deepcopy((self.connection.spans,self.connection.snapshots,self.connection.status,self.connection.totals))
        self.connection.in_transaction=True
    async def __aexit__(self,kind,error,tb):
        if kind:self.connection.spans,self.connection.snapshots,self.connection.status,self.connection.totals=self.saved
        self.connection.in_transaction=False
        return False


class Connection:
    def __init__(self,fail=False):
        self.spans={};self.snapshots=[];self.status='RUNNING';self.events=[];self.totals=None;self.in_transaction=False;self.fail=fail
    def transaction(self):return Transaction(self)
    async def fetchrow(self,sql,trace_id):
        assert 'FOR UPDATE' in sql and self.in_transaction
        return {'status':self.status}
    async def execute(self,sql,*args):
        assert self.in_transaction
        if 'INSERT INTO spans' in sql:
            if self.fail and args[4]=='AGENT_REASONING':raise RuntimeError('Persistence failed')
            assert args[0] not in self.spans
            self.spans[args[0]]={'latency':args[7],'cost':Decimal(str(args[9] or 0))}
            self.events.append('span')
        elif 'INSERT INTO state_snapshots' in sql:
            self.snapshots.append(args);self.events.append('snapshot')
        elif 'UPDATE traces' in sql:
            assert 'SUM(latency_ms)' in sql and 'SUM(estimated_cost_usd)' in sql
            self.status=args[1]
            self.totals=(sum(row['latency'] for row in self.spans.values()),sum(row['cost'] for row in self.spans.values()))
            self.events.append('totals')


def pool_for(connection):
    pool=MagicMock()
    pool.acquire.return_value.__aenter__=AsyncMock(return_value=connection)
    pool.acquire.return_value.__aexit__=AsyncMock(return_value=False)
    return pool


@pytest.mark.asyncio
async def test_totals_after_all_spans_and_snapshots_in_one_transaction():
    connection=Connection()
    rows=await persist_recording(pool_for(connection),sample_recording())
    assert len(rows)==2
    assert connection.events==['span','span','snapshot','totals']
    assert connection.totals==(123,Decimal('0.000217'))
    assert connection.status=='SUCCESS'
    with pytest.raises(ValueError):await persist_recording(pool_for(connection),sample_recording())
    assert len(connection.spans)==2 and len(connection.snapshots)==1


@pytest.mark.asyncio
async def test_partial_insert_failure_rolls_back_all_records_and_success_status():
    connection=Connection(fail=True)
    with pytest.raises(RuntimeError):await persist_recording(pool_for(connection),sample_recording())
    assert connection.spans=={} and connection.snapshots==[]
    assert connection.status=='RUNNING' and connection.totals is None

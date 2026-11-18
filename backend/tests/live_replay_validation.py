"""Manual live validation: create fresh forks; never alter the two source traces."""
import argparse
import asyncio
from decimal import Decimal
import json
import os
from pathlib import Path
import uuid
from urllib.request import Request,urlopen

import asyncpg
from dotenv import load_dotenv

parser=argparse.ArgumentParser()
parser.add_argument('--base',default='http://127.0.0.1:8011')
args=parser.parse_args()
load_dotenv(Path(__file__).resolve().parents[1]/'.env')
PARENT='7db3d960fb704c469fed417b440bf775'
OLD_FORK='50678d086ff046cdbb34ec59bde2c63a'


def http(path,data=None):
    body=json.dumps(data).encode() if data is not None else None
    request=Request(args.base+path,data=body,headers={'Content-Type':'application/json'},method='POST' if data is not None else 'GET')
    with urlopen(request,timeout=180) as response:return json.load(response)


def decode(value):return json.loads(value) if isinstance(value,str) else value


async def snapshot(conn):
    result={}
    async with conn.transaction(readonly=True):
        for table,key in (('traces','trace_id'),('spans','span_id'),('state_snapshots','snapshot_id'),('evaluations','eval_id')):
            rows=await conn.fetch(f'SELECT * FROM {table} WHERE trace_id = ANY($1::varchar[]) ORDER BY {key}',[PARENT,OLD_FORK])
            result[table]=[dict(row) for row in rows]
    return result


async def verify(conn,source,step,overrides,expected_field,expected_text,expected_spans,extra=None):
    # Execute the real model workflow through the existing HTTP contract.
    result=await asyncio.to_thread(http,'/replay',{'trace_id':source,'step_number':step,'overrides':overrides})
    tid=result['forked_trace_id']
    assert tid not in (PARENT,OLD_FORK)
    assert set(result)=={'status','original_trace_id','forked_trace_id','forked_from_step'}
    async with conn.transaction(readonly=True):
        trace=await conn.fetchrow('SELECT * FROM traces WHERE trace_id=$1',tid)
        source_row=await conn.fetchrow('SELECT project_id FROM traces WHERE trace_id=$1',source)
        spans=await conn.fetch('SELECT * FROM spans WHERE trace_id=$1 ORDER BY created_at,span_id',tid)
        checkpoints=await conn.fetch('SELECT * FROM state_snapshots WHERE trace_id=$1',tid)
        assert trace['status']=='SUCCESS' and trace['parent_trace_id']==source
        assert trace['project_id']==source_row['project_id']
        assert len(spans)==expected_spans and len({span['span_id'] for span in spans})==expected_spans
        roots=[span for span in spans if span['parent_span_id'] is None]
        assert len(roots)==1 and roots[0]['span_type']=='REPLAY_INPUT'
        boundary=roots[0]
        assert boundary['agent_name']==('researcher' if step==1 else 'writer')
        provenance=decode(boundary['input_payload'])['replay']
        assert provenance['mode']=='overridden' and provenance['model_executed'] is False
        assert provenance['source_trace_id']==source and provenance['source_span_id']
        assert decode(boundary['output_payload'])=={expected_field:expected_text}
        assert boundary['token_usage'] is None and boundary['estimated_cost_usd'] is None and boundary['latency_ms']==0
        known=set()
        for span in spans:
            assert span['trace_id']==tid
            assert span['parent_span_id'] is None or span['parent_span_id'] in known
            known.add(span['span_id'])
        assert not any(span['agent_name']==boundary['agent_name'] and span['span_type']=='AGENT_REASONING' for span in spans)
        downstream=next(span for span in spans if span['agent_name']==('writer' if step==1 else 'critic') and span['span_type']=='AGENT_REASONING')
        assert expected_text in decode(downstream['input_payload'])['user']
        checkpoint=next(row for row in checkpoints if row['span_id']==boundary['span_id'])
        state=decode(checkpoint['state_data'])
        assert state[expected_field]==expected_text
        if extra:assert state['validation']==extra
        assert len({(row['span_id'],row['step_number']) for row in checkpoints})==len(checkpoints)
        expected_latency=sum(row['latency_ms'] or 0 for row in spans)
        expected_cost=sum((row['estimated_cost_usd'] or Decimal(0) for row in spans),Decimal(0))
        assert trace['total_latency_ms']==expected_latency
        assert trace['total_cost_usd']==expected_cost
        assert expected_latency>0 and expected_cost>0
        if step==1:
            writer=next(span for span in spans if span['agent_name']=='writer')
            critic=next(span for span in spans if span['agent_name']=='critic')
            assert decode(writer['output_payload'])['article'] in decode(critic['input_payload'])['user']
    payload=await asyncio.to_thread(http,'/trace/'+tid)
    pending=list(payload['span_tree']);api_ids=[]
    while pending:
        span=pending.pop();api_ids.append(span['span_id']);pending.extend(span.get('children') or [])
    assert set(api_ids)==known
    print(json.dumps({'new_fork':tid,'source_trace':source,'step':step,'span_count':len(spans),'boundary':provenance['mode'],'override_received':True,'all_parents_exist':True,'project_preserved':True,'latency_ms':expected_latency,'cost_usd':str(expected_cost),'totals_match':True}),flush=True)
    return tid


async def main():
    conn=await asyncpg.connect(os.getenv('DATABASE_URL'),timeout=15)
    created=[]
    before=await snapshot(conn)
    try:
        async with conn.transaction(readonly=True):
            original=await conn.fetchrow('SELECT state_data FROM state_snapshots WHERE trace_id=$1 AND step_number=1 ORDER BY created_at DESC LIMIT 1',PARENT)
            fork=await conn.fetchrow('SELECT state_data FROM state_snapshots WHERE trace_id=$1 AND step_number=2 ORDER BY created_at DESC LIMIT 1',OLD_FORK)
        marker=uuid.uuid4().hex[:8]
        findings=decode(original['state_data'])['findings']+f'\nReplay validation marker {marker}: keep claims cautious and evidence-based.'
        created.append(await verify(conn,PARENT,1,{'raw':findings},'findings',findings,5))
        article=decode(fork['state_data'])['article']+f'\n\nReplay validation marker {marker}: identify any unsupported claims in this article.'
        extra={'purpose':'fresh-fork regression validation','marker':marker}
        created.append(await verify(conn,OLD_FORK,2,{'article':article,'validation':extra},'article',article,3,extra))
    finally:
        after=await snapshot(conn)
        unchanged=before==after
        await conn.close()
        print(json.dumps({'source_traces_unchanged':unchanged,'preserved_rows':{table:len(rows) for table,rows in before.items()},'fresh_forks':created}),flush=True)
        if not unchanged:raise AssertionError('A protected source record changed')
    print('PASS: live fresh forks verified; original traces/spans/snapshots/evaluations preserved.')

if __name__=='__main__':asyncio.run(main())

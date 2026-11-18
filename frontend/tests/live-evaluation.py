"""Live append-only rubric comparison. Uses existing local HTTP endpoints only.

Does not create traces, access credentials, or replace model responses. Existing
PASS/FAIL/ERROR records must remain byte-for-byte equivalent in the GET response.
"""
import argparse
import json
import sys
from urllib.request import Request,urlopen
from urllib.error import URLError,HTTPError

parser=argparse.ArgumentParser()
parser.add_argument('--trace-id',default='7db3d960fb704c469fed417b440bf775')
parser.add_argument('--base',default='http://127.0.0.1:8000')
args=parser.parse_args()
PREFIX='[swt-eval:role-v2] '
def request(path,method='GET'):
    with urlopen(Request(args.base+path,method=method),timeout=180) as response:
        return json.load(response)
try:
    before=request('/evaluations/'+args.trace_id)
    before_by_id={row['eval_id']:row for row in before}
    print('Evaluating existing trace:',args.trace_id,flush=True)
    result=request('/evaluate/'+args.trace_id,'POST')
    after=request('/evaluations/'+args.trace_id)
    after_by_id={row['eval_id']:row for row in after}
    if not all(after_by_id.get(identifier)==row for identifier,row in before_by_id.items()):
        raise AssertionError('Historical evaluation records changed or disappeared.')
    comparisons=[]
    for role in ('researcher','writer','critic','orchestrator'):
        old=[row for row in before if row['agent_name']==role and not row['feedback'].startswith(PREFIX)]
        current=[row for row in after if row['agent_name']==role and row['feedback'].startswith(PREFIX)]
        if not current: raise AssertionError('No corrected-rubric record for '+role)
        row=current[-1]
        metadata=json.loads(row['feedback'][len(PREFIX):])
        if row['verdict'] not in ('PASS','FAIL') or row['overall'] is None:
            print(json.dumps({'agent':role,'unavailable':metadata},ensure_ascii=True))
            raise AssertionError('Actual corrected-rubric evaluation unavailable for '+role)
        comparisons.append({'agent':role,'old_overall':old[-1]['overall'] if old else None,'new_overall':row['overall'],'new_verdict':row['verdict'],'evaluator':row['judge_model'],'rubric':metadata['rubric'],'feedback':metadata['summary'],'context':metadata.get('context'),'criteria':metadata.get('criteria')})
    print(json.dumps({'preserved_historical_records':len(before),'total_records_after':len(after),'newly_evaluated':result.get('evaluated',0),'comparison':comparisons},ensure_ascii=True))
    print('PASS: actual role-specific evaluations verified; all pre-existing records unchanged.')
except HTTPError as error:
    print('NOT VERIFIED: backend returned HTTP',error.code)
    sys.exit(1)
except (URLError,TimeoutError,OSError):
    print('NOT VERIFIED: local backend or upstream unavailable/timed out.')
    sys.exit(1)
except AssertionError as error:
    print('NOT VERIFIED:',str(error))
    sys.exit(1)

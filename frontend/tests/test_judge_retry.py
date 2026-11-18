"""Regression tests with isolated fixtures; no real judge or database calls."""
import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from evaluation import (AssessmentUnavailable, FEEDBACK_PREFIX, MAX_CONTEXT_BYTES, content_prompt, decode_payload, orchestration_assessment, parsed_scores)
from routers.evaluate import evaluate_trace


def workflow():
    root = {'span_id': 'root', 'parent_span_id': None, 'agent_name': 'orchestrator', 'span_type': 'AGENT_REASONING', 'input_payload': {'topic': 'Example topic'}, 'output_payload': {'status': 'complete', 'steps_completed': 3}}
    spans = [root]
    source = root
    for index, (role, key, text) in enumerate([('researcher','findings','Evidence A.'), ('writer','article','Complete article.'), ('critic','critique','Specific critique.')]):
        handoff = {'span_id': f'handoff-{index}', 'parent_span_id': source['span_id'], 'agent_name': 'orchestrator', 'span_type': 'HANDOFF', 'input_payload': {'sender':source['agent_name'],'receiver':role}, 'output_payload': {'status':'handed_off'}}
        inputs = {'user': 'Example topic' if index == 0 else source['output_payload']['findings' if index == 1 else 'article'], 'system':'Recorded role instructions'}
        agent = {'span_id':role,'parent_span_id':handoff['span_id'],'agent_name':role,'span_type':'AGENT_REASONING','input_payload':inputs,'output_payload':{key:text}}
        spans += [handoff,agent]
        source = agent
    return root, spans


class RubricTests(unittest.TestCase):
    def test_role_prompts_keep_long_full_payloads_without_double_encoding(self):
        for role in ('researcher','writer','critic'):
            span = {'agent_name':role,'input_payload':json.dumps({'task':'TASK ' + 'context. '*350}), 'output_payload':json.dumps({'answer':'Output sentence. '*350 + 'COMPLETE ENDING.'})}
            prompt, context = content_prompt(span)
            self.assertIn('COMPLETE ENDING.', prompt)
            self.assertNotIn('\\"answer\\"', prompt)
            self.assertIn(f'evaluating a {role}', prompt)
            self.assertFalse(context['omitted'])
            self.assertGreater(context['bytes'], 2000)

    def test_over_budget_is_explicitly_unscored_not_truncated(self):
        with self.assertRaisesRegex(AssessmentUnavailable,'Nothing was truncated'):
            content_prompt({'agent_name':'writer','input_payload':{},'output_payload':{'article':'x' * MAX_CONTEXT_BYTES}})

    def test_missing_payload_and_unsupported_role_are_unavailable(self):
        for span in ({'agent_name':'writer','input_payload':{},'output_payload':None}, {'agent_name':'custom-agent','input_payload':{},'output_payload':{}}):
            with self.assertRaises(AssessmentUnavailable): content_prompt(span)
        self.assertEqual(decode_payload(json.dumps(json.dumps({'article':'full'}))), {'article':'full'})

    def test_no_fabricated_defaults_or_invalid_judge_scores(self):
        for scores in ({'feedback':'Missing scores'}, {'relevance':float('nan'),'reasoning':8,'quality':8,'feedback':'Invalid'}, {'relevance':True,'reasoning':8,'quality':8,'feedback':'Invalid'}):
            with self.assertRaises(AssessmentUnavailable): parsed_scores(scores)
        values, overall, _, unavailable = parsed_scores({'relevance':9,'reasoning':None,'quality':8,'feedback':'Reasoning evidence unavailable'})
        self.assertIsNone(overall)
        self.assertIsNone(values['reasoning'])
        self.assertTrue(unavailable)

    def test_orchestration_requires_all_five_evidence_checks(self):
        root, spans = workflow()
        _, overall, verdict, feedback = orchestration_assessment({'status':'SUCCESS'}, root, spans)
        self.assertEqual((overall,verdict),(10,'PASS'))
        metadata=json.loads(feedback[len(FEEDBACK_PREFIX):])
        self.assertEqual(len(metadata['criteria']),5)
        self.assertTrue(all(item['state']=='passed' for item in metadata['criteria']))

    def test_success_status_without_execution_evidence_is_not_high_score(self):
        root, _ = workflow()
        values, overall, verdict, feedback = orchestration_assessment({'status':'SUCCESS'},root,[root])
        self.assertIsNone(overall)
        self.assertEqual(verdict,'ERROR')
        self.assertIn('unavailable',feedback)

    def test_wrong_handoff_is_a_failure_even_with_success_status(self):
        root, spans=workflow()
        spans[1]['input_payload']['receiver']='wrong-agent'
        _, _, verdict, feedback=orchestration_assessment({'status':'SUCCESS'},root,spans)
        self.assertEqual(verdict,'FAIL')
        self.assertIn('recorded routing or parent link mismatch',feedback)

    def test_incorrect_data_propagation_is_not_hidden_by_completion(self):
        root, spans=workflow()
        next(span for span in spans if span['agent_name']=='writer')['input_payload']['user']='Unrelated data'
        _, _, verdict, feedback=orchestration_assessment({'status':'SUCCESS'},root,spans)
        self.assertEqual(verdict,'FAIL')
        self.assertIn('does not contain full source output',feedback)

    def test_missing_completion_fields_are_unavailable(self):
        root,spans=workflow()
        del root['output_payload']['steps_completed']
        _,overall,verdict,_=orchestration_assessment({'status':'SUCCESS'},root,spans)
        self.assertIsNone(overall)
        self.assertEqual(verdict,'ERROR')


class AppendOnlyTests(unittest.IsolatedAsyncioTestCase):
    async def assess(self, failure=False, completed=False, too_long=False, missing=False, response_limited=False):
        root,spans=workflow()
        span=next(span for span in spans if span['agent_name']=='researcher')
        span=copy.deepcopy(span)
        if too_long: span['output_payload']={'findings':'x'*MAX_CONTEXT_BYTES}
        if missing: span['output_payload']=None
        conn=MagicMock()
        conn.fetchrow=AsyncMock(return_value={'trace_id':'test','status':'SUCCESS'})
        conn.fetch=AsyncMock(side_effect=[[span], [{'span_id':span['span_id']}] if completed else []])
        conn.fetchval=AsyncMock(return_value=False)
        conn.execute=AsyncMock()
        pool=MagicMock()
        pool.acquire.return_value.__aenter__.return_value=conn
        client=MagicMock()
        if failure: client.chat.completions.create.side_effect=RuntimeError('secret-provider-detail')
        else:
            client.chat.completions.create.return_value.choices[0].message.content='{"relevance":8,"reasoning":9,"quality":7,"feedback":"Supported by recorded test evidence","unavailable":[]}'
            client.chat.completions.create.return_value.choices[0].finish_reason='length' if response_limited else 'stop'
        with patch('routers.evaluate.get_pool',AsyncMock(return_value=pool)),patch('routers.evaluate._get_groq_client',return_value=client) as factory:
            result=await evaluate_trace('test')
        return result,conn,factory

    async def test_new_rubric_appends_without_updates_or_deletes(self):
        result,conn,_=await self.assess()
        self.assertEqual(result['results'][0]['verdict'],'PASS')
        self.assertEqual(result['results'][0]['overall'],8)
        queries=[call.args[0] for call in conn.execute.await_args_list]
        self.assertEqual(sum('INSERT INTO evaluations' in query for query in queries),1)
        self.assertFalse(any('UPDATE ' in query or 'DELETE ' in query for query in queries))
        self.assertEqual(conn.fetch.await_args_list[1].args[2],FEEDBACK_PREFIX+'%')

    async def test_current_rubric_completed_assessments_are_skipped(self):
        result,conn,factory=await self.assess(completed=True)
        self.assertNotIn('evaluated',result)
        factory.assert_not_called()
        conn.execute.assert_not_awaited()

    async def test_error_appends_null_scores_and_sanitized_explanation(self):
        result,conn,_=await self.assess(failure=True)
        self.assertEqual(result['results'][0]['verdict'],'ERROR')
        self.assertIsNone(result['results'][0]['overall'])
        self.assertNotIn('secret-provider-detail',result['results'][0]['feedback'])
        inserted=next(call for call in conn.execute.await_args_list if 'INSERT INTO evaluations' in call.args[0])
        self.assertEqual(inserted.args[5:9],(None,None,None,None))

    async def test_over_budget_does_not_call_judge(self):
        result,_,factory=await self.assess(too_long=True)
        self.assertIsNone(result['results'][0]['overall'])
        self.assertIn('Nothing was truncated',result['results'][0]['feedback'])
        factory.assert_not_called()

    async def test_missing_output_does_not_call_judge(self):
        result,_,factory=await self.assess(missing=True)
        self.assertEqual(result['results'][0]['verdict'],'ERROR')
        factory.assert_not_called()

    async def test_judge_generation_limit_is_not_an_agent_zero_score(self):
        result,_,_=await self.assess(response_limited=True)
        self.assertEqual(result['results'][0]['verdict'],'ERROR')
        self.assertIsNone(result['results'][0]['overall'])
        self.assertIn('generation budget',result['results'][0]['feedback'])

if __name__=='__main__': unittest.main()

"""Real PostgreSQL isolation regression tests; only session-local TEMP tables are written.

Run with SWT_AUTH_DB_TESTS=1. No dependency overrides, startup migrations, public
data writes, external model calls, or live user/key changes are performed.
"""
import asyncio
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import asyncpg
import pytest
from auth import authorization, dependencies
from auth.utils import create_access_token, hash_password
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import audit, auth, evaluate, export, ingest, projects, replay, traces, ws
from starlette.websockets import WebSocketDisconnect
from tracing.otel_setup import ReplayCapture, Span

pytestmark = pytest.mark.skipif(os.getenv("SWT_AUTH_DB_TESTS") != "1", reason="Opt-in PostgreSQL TEMP-table tests")
USERS = {name: UUID(int=i) for i, name in enumerate(["a", "b", "empty", "viewer"], 101)}
PROJECTS = {"a": UUID(int=201), "b": UUID(int=202)}


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(str(USERS[user]), f"{user}@example.invalid")}


@pytest.fixture(scope="module")
def isolated():
    app = FastAPI()
    for module in (auth, projects, traces, replay, evaluate, export, ingest, ws):
        app.include_router(module.router)
    # Patch only storage acquisition. All real JWT/security dependencies and SQL run.
    patcher = pytest.MonkeyPatch()
    with TestClient(app) as client:
        async def setup():
            parts = urlsplit(os.environ["DATABASE_URL"])
            # Use the direct endpoint when configured with a Neon transaction pooler.
            authority = parts.netloc.rsplit('@', 1)
            authority[-1] = authority[-1].replace('-pooler.', '.')
            dsn = urlunsplit(parts._replace(netloc='@'.join(authority)))
            connection = await asyncpg.connect(dsn, timeout=20)
            transaction = connection.transaction()
            await transaction.start()  # Pin one server connection for every TEMP table.
            for table in ("users", "projects", "project_members", "traces", "spans", "state_snapshots", "evaluations", "api_keys", "audit_logs"):
                await connection.execute(f"CREATE TEMP TABLE {table} (LIKE public.{table} INCLUDING ALL) ON COMMIT DROP")
            # Do not advance the public snapshot sequence copied by LIKE.
            await connection.execute("CREATE TEMP SEQUENCE auth_snapshot_ids")
            await connection.execute("ALTER TABLE pg_temp.state_snapshots ALTER snapshot_id SET DEFAULT nextval('pg_temp.auth_snapshot_ids')")
            password_hash = hash_password("isolated-test-password")
            for name, uid in USERS.items():
                await connection.execute("INSERT INTO users(user_id,email,name,password_hash) VALUES($1,$2,$3,$4)", uid, f"{name}@example.invalid", name, password_hash)
            for name, pid in PROJECTS.items():
                await connection.execute("INSERT INTO projects(project_id,user_id,name) VALUES($1,$2,$3)", pid, USERS[name], name)
                await connection.execute("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')", pid, USERS[name])
                await connection.execute("INSERT INTO traces(trace_id,project_id,root_agent,status,total_latency_ms,total_cost_usd) VALUES($1,$2,'researcher','SUCCESS',100,0.01)", name, pid)
                await connection.execute("INSERT INTO spans(span_id,trace_id,agent_name,span_type,input_payload,output_payload,latency_ms) VALUES($1,$2,'researcher','REPLAY_INPUT','{}','{}',100)", "span-" + name, name)
                await connection.execute("INSERT INTO state_snapshots(trace_id,span_id,step_number,agent_name,state_data) VALUES($1,$2,1,'researcher',$3)", name, "span-" + name, '{"findings":"sample"}')
            await connection.execute("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", PROJECTS['a'], USERS['viewer'])
            # A key owned by A must remain limited to A even if A later joins B.
            await connection.execute("INSERT INTO api_keys(user_id,project_id,name,key_value) VALUES($1,$2,'test','isolated-key-a')", USERS['a'], PROJECTS['a'])
            return connection, transaction
        connection, transaction = client.portal.call(setup)
        lock = client.portal.call(asyncio.Lock)

        class Pool:
            @asynccontextmanager
            async def acquire(self):
                async with lock:
                    yield connection

        async def pool():
            return Pool()
        for module in (authorization, dependencies, auth, projects, traces, replay, evaluate, export, ingest, ws, audit):
            patcher.setattr(module, "get_pool", pool)
        yield client, connection
        client.portal.call(transaction.rollback)
        client.portal.call(connection.close)
    patcher.undo()


@pytest.mark.parametrize("user,other", [("a", "b"), ("b", "a")])
def test_lists_details_metrics_and_cross_account_denials(isolated, user, other):
    client, _ = isolated
    own = headers(user)
    assert [r['trace_id'] for r in client.get('/traces', headers=own).json()] == [user]
    assert client.get('/metrics', headers=own).json()['summary']['total_traces'] == 1
    assert client.get(f'/trace/{user}', headers=own).status_code == 200
    assert client.get(f'/evaluations/{user}', headers=own).status_code == 200
    assert client.get(f'/export/otlp/{user}', headers=own).status_code == 200
    assert client.post(f'/evaluate/{user}', headers=own).status_code == 200
    for path in (f'/traces?project_id={PROJECTS[other]}', f'/metrics?project_id={PROJECTS[other]}',
                 f'/projects/{PROJECTS[other]}', f'/trace/{other}', f'/evaluations/{other}',
                 f'/export/otlp/{other}', f'/export/otlp/{other}/download'):
        assert client.get(path, headers=own).status_code == 404, path
    assert client.post('/replay', headers=own, json={'trace_id': other, 'step_number': 1}).status_code == 404
    assert client.post(f'/evaluate/{other}', headers=own).status_code == 404
    assert client.patch(f'/traces/{other}/complete', headers=own).status_code == 404
    # Diff uses two GET /trace calls; either inaccessible side prevents comparison.
    assert [client.get(f'/trace/{t}', headers=own).status_code for t in (user, other)] == [200, 404]


@pytest.mark.parametrize("auth_headers", [{}, {"Authorization": "Bearer invalid"}, {"X-API-Key": "invalid"}])
def test_missing_and_invalid_authentication(isolated, auth_headers):
    client, _ = isolated
    for path in ('/traces', '/metrics', '/trace/a', '/evaluations/a', '/projects', '/export/otlp/a'):
        assert client.get(path, headers=auth_headers).status_code == 401
    assert client.post('/evaluate/a', headers=auth_headers).status_code == 401
    assert client.post('/replay', headers=auth_headers, json={'trace_id':'a','step_number':1}).status_code == 401


def test_empty_membership_and_invalid_projects(isolated):
    client, _ = isolated
    assert client.get('/projects', headers=headers('empty')).json() == []
    assert client.get('/traces', headers=headers('empty')).json() == []
    metrics = client.get('/metrics', headers=headers('empty')).json()
    assert metrics['summary']['total_traces'] == 0 and metrics['daily'] == []
    for project in (str(PROJECTS['a']), 'not-a-uuid', ''):
        assert client.get('/traces', headers=headers('empty'), params={'project_id':project}).status_code == 404


def test_viewer_cannot_execute_and_keys_cannot_expand_scope(isolated):
    client, conn = isolated
    assert client.get('/trace/a', headers=headers('viewer')).status_code == 200
    assert client.post('/evaluate/a', headers=headers('viewer')).status_code == 404
    assert client.post('/replay', headers=headers('viewer'), json={'trace_id':'a','step_number':1}).status_code == 404
    client.portal.call(conn.execute, "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'developer')", PROJECTS['b'], USERS['a'])
    try:
        assert len(client.get('/traces', headers=headers('a')).json()) == 2
        key = {'X-API-Key':'isolated-key-a'}
        assert [r['trace_id'] for r in client.get('/traces', headers=key).json()] == ['a']
        assert client.get('/trace/b', headers=key).status_code == 404
    finally:
        client.portal.call(conn.execute, 'DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', PROJECTS['b'], USERS['a'])


def test_ingestion_rejects_foreign_traces_atomically(isolated):
    client, _ = isolated
    def span(trace, sid):
        return {'trace_id':trace,'span_id':sid,'agent_name':'researcher','span_type':'REPLAY_INPUT','input_payload':{},'output_payload':{},'latency_ms':0}
    payload = {'spans':[span('new-ingest-a','new-span-a'),span('b','attack-span')]}
    assert client.post('/ingest', headers=headers('a'), json=payload).status_code == 404
    assert client.get('/trace/new-ingest-a', headers=headers('a')).status_code == 404
    assert client.post('/ingest?project_id='+str(PROJECTS['b']),headers=headers('a'),json={'spans':[]}).status_code == 404
    assert client.post('/ingest',headers=headers('a'),json={'spans':[span('a','own-extra')]}).status_code == 200


def test_authorized_replay_persists_scoped_fork(isolated, monkeypatch):
    client, conn = isolated
    async def resume(**kwargs):
        capture = ReplayCapture(kwargs['new_trace_id'])
        boundary = Span(kwargs['new_trace_id'],'researcher','REPLAY_INPUT',{})
        boundary.end({'findings':'sample'})
        capture.record([boundary],[])
        return capture
    monkeypatch.setattr('agents.orchestrator.resume_from_snapshot', resume)
    response = client.post('/replay',headers=headers('a'),json={'trace_id':'a','step_number':1,'overrides':{'findings':'override'}})
    assert response.status_code == 200
    fork = response.json()['forked_trace_id']
    try:
        assert client.get('/trace/'+fork,headers=headers('a')).json()['trace']['project_id'] == str(PROJECTS['a'])
        assert client.get('/trace/'+fork,headers=headers('b')).status_code == 404
    finally:
        client.portal.call(conn.execute,'DELETE FROM spans WHERE trace_id=$1',fork)
        client.portal.call(conn.execute,'DELETE FROM traces WHERE trace_id=$1',fork)


@pytest.mark.parametrize('path', ['/ws/traces?project_id='+str(PROJECTS['b']), '/ws/trace/b'])
def test_foreign_websocket_subscription_rejected(isolated, path):
    client, _ = isolated
    with client.websocket_connect(path) as socket:
        socket.send_json({'type':'AUTH','token':headers('a')['Authorization'][7:]})
        with pytest.raises(WebSocketDisconnect) as failure:
            socket.receive_json()
        assert failure.value.code == 4403


def test_websocket_authentication_and_filtered_live_events(isolated):
    client, conn = isolated
    with client.websocket_connect('/ws/traces') as invalid:
        invalid.send_json({'type':'AUTH','token':'invalid'})
        with pytest.raises(WebSocketDisconnect) as failure:
            invalid.receive_json()
        assert failure.value.code == 4401
    with client.websocket_connect('/ws/traces') as socket:
        socket.send_json({'type':'AUTH','token':headers('a')['Authorization'][7:]})
        assert socket.receive_json()['type'] == 'AUTHENTICATED'
        client.portal.call(ws.broadcast_trace_update,'b','SUCCESS','researcher')
        client.portal.call(ws.broadcast_trace_update,'a','SUCCESS','researcher')
        assert socket.receive_json()['trace_id'] == 'a'  # B was not queued or disclosed.
    with client.websocket_connect('/ws/trace/a') as socket:
        socket.send_json({'type':'AUTH','token':headers('a')['Authorization'][7:]})
        assert socket.receive_json()['type'] == 'AUTHENTICATED'
        client.portal.call(ws.broadcast_span,'a',{'span_id':'live-a'})
        assert socket.receive_json()['span']['span_id'] == 'live-a'
        client.portal.call(conn.execute,'DELETE FROM project_members WHERE user_id=$1 AND project_id=$2',USERS['a'],PROJECTS['a'])
        try:
            client.portal.call(ws.broadcast_span,'a',{'span_id':'must-not-leak'})
            with pytest.raises(WebSocketDisconnect) as failure:
                socket.receive_json()
            assert failure.value.code == 4403
        finally:
            client.portal.call(conn.execute,"INSERT INTO project_members(user_id,project_id,role) VALUES($1,$2,'admin')",USERS['a'],PROJECTS['a'])


def test_registration_has_no_implicit_memberships_and_can_create_project(isolated):
    client, _ = isolated
    response = client.post('/auth/register',json={'name':'New','email':'new@example.com','password':'isolated-test-password'})
    assert response.status_code == 200
    token = {'Authorization':'Bearer '+response.json()['access_token']}
    assert client.get('/projects',headers=token).json() == []
    assert client.get('/traces',headers=token).json() == []
    response = client.post('/projects',headers=token,json={'name':'My new project'})
    assert response.status_code == 200
    assert response.json()['your_role'] == 'admin'
    assert len(client.get('/projects',headers=token).json()) == 1
    assert client.get('/traces',headers=token).json() == []


def test_authorized_evaluation_executes_and_persists_only_in_own_project(isolated, monkeypatch):
    client, conn = isolated
    client.portal.call(conn.execute, "INSERT INTO spans(span_id,trace_id,agent_name,span_type,input_payload,output_payload) VALUES('judge-a','a','researcher','AGENT_REASONING','{\"topic\":\"test\"}','{\"findings\":\"test evidence\"}')")
    calls = []
    def judge(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop', message=SimpleNamespace(content='{\"relevance\":8,\"reasoning\":8,\"quality\":8,\"feedback\":\"Isolated test judge\"}'))])
    monkeypatch.setattr(evaluate, '_get_groq_client', lambda: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=judge))))
    assert client.post('/evaluate/a',headers=headers('b')).status_code == 404
    assert calls == []
    response = client.post('/evaluate/a',headers=headers('a'))
    assert response.status_code == 200
    assert response.json()['evaluated'] == 1 and len(calls) == 1
    assert len(client.get('/evaluations/a',headers=headers('a')).json()) == 1
    assert client.get('/evaluations/a',headers=headers('b')).status_code == 404


@pytest.mark.parametrize('message', [{}, {'type':'AUTH'}, {'type':'AUTH','token':None}])
def test_missing_websocket_credentials_are_rejected(isolated, message):
    client, _ = isolated
    with client.websocket_connect('/ws/traces') as socket:
        socket.send_json(message)
        with pytest.raises(WebSocketDisconnect) as failure:
            socket.receive_json()
        assert failure.value.code == 4401

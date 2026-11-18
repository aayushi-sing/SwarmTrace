"""Legacy endpoint unit fixtures: real JWT verification, isolated database records."""
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch
from uuid import UUID

import httpx
import pytest
from auth.utils import create_access_token
from main import app

USER_ID = '00000000-0000-0000-0000-000000000001'
PROJECT_ID = UUID('00000000-0000-0000-0000-000000000011')


@pytest.fixture
def client():
    # Only the database is replaced. Authentication/authorization dependencies run normally.
    conn = AsyncMock()
    conn.fetch.return_value = [{"project_id": PROJECT_ID, "role": "admin"}]
    async def trace(query, *args):
        return {"trace_id": "trace001", "project_id": PROJECT_ID} if args[0] == "trace001" else None
    conn.fetchrow.side_effect = trace
    class Pool:
        @asynccontextmanager
        async def acquire(self):
            yield conn
    with patch('auth.authorization.get_pool', new=AsyncMock(return_value=Pool())):
        transport = httpx.ASGITransport(app=app)
        yield httpx.AsyncClient(transport=transport, base_url="http://test", headers={
            "Authorization": "Bearer " + create_access_token(USER_ID, "test@example.invalid"),
        })


@pytest.fixture
def sample_span_payload():
    """A minimal valid IngestRequest payload for testing."""
    return {
        "spans": [
            {
                "span_id":        "abc123def456",
                "trace_id":       "trace001",
                "parent_span_id": None,
                "agent_name":     "orchestrator",
                "span_type":      "AGENT_REASONING",
                "input_payload":  {"prompt": "test"},
                "output_payload": {"response": "ok"},
                "latency_ms":     100,
                "token_usage":    {"prompt_tokens": 10, "completion_tokens": 5},
            }
        ],
        "snapshots": [
            {
                "trace_id":    "trace001",
                "span_id":     "abc123def456",
                "step_number": 1,
                "agent_name":  "orchestrator",
                "state_data":  {"key": "value"},
            }
        ],
    }
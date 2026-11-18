"""tests/test_ingest.py — Ingest endpoint tests.

C4: /ingest now requires auth (require_auth dependency).
Fix: override the dependency in the test client so tests don't need a real JWT.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from tests.conftest import PROJECT_ID

# The user dict that require_auth would normally return
MOCK_USER = {"user_id": "test-user-id", "email": "test@example.com", "project_id": None}


@pytest.mark.asyncio
async def test_ingest_valid_span(client, sample_span_payload):
    """Valid span payload should be accepted and return spans_ingested count."""
    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock()
    mock_conn.transaction = MagicMock(return_value=AsyncMock())
    mock_conn.fetchrow = AsyncMock(return_value=None)
    async def fetchval(query, *args):
        if "FOR UPDATE" in query: return PROJECT_ID
        if "SELECT EXISTS" in query: return True
        if "SELECT trace_id FROM spans" in query: return "trace001"
        return 0
    mock_conn.fetchval = AsyncMock(side_effect=fetchval)

    mock_pool = MagicMock()
    mock_pool.acquire = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_conn),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("routers.ingest.get_pool", return_value=mock_pool), \
         patch("routers.ingest.require_auth", return_value=MOCK_USER), \
         patch("routers.ingest.broadcast_trace_update", new_callable=AsyncMock), \
         patch("routers.ingest.broadcast_span", new_callable=AsyncMock):
        response = await client.post("/ingest", json=sample_span_payload)

    assert response.status_code == 200
    assert response.json()["spans_ingested"] == 1


@pytest.mark.asyncio
async def test_ingest_missing_required_field(client):
    """Payload missing span_id should return 422 Unprocessable Entity."""
    bad_payload = {
        "spans": [
            {
                # span_id is missing
                "trace_id": "trace001",
                "agent_name": "orchestrator",
                "span_type": "AGENT_REASONING",
                "input_payload": {},
                "output_payload": {},
                "latency_ms": 100,
            }
        ]
    }
    with patch("routers.ingest.require_auth", return_value=MOCK_USER):
        response = await client.post("/ingest", json=bad_payload)

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_ingest_empty_spans(client):
    """Empty spans list should succeed with spans_ingested = 0."""
    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock()
    mock_conn.transaction = MagicMock(return_value=AsyncMock())
    mock_conn.fetchrow = AsyncMock(return_value=None)
    async def fetchval(query, *args):
        if "FOR UPDATE" in query: return PROJECT_ID
        if "SELECT EXISTS" in query: return True
        if "SELECT trace_id FROM spans" in query: return "trace001"
        return 0
    mock_conn.fetchval = AsyncMock(side_effect=fetchval)

    mock_pool = MagicMock()
    mock_pool.acquire = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_conn),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("routers.ingest.get_pool", return_value=mock_pool), \
         patch("routers.ingest.require_auth", return_value=MOCK_USER), \
         patch("routers.ingest.broadcast_trace_update", new_callable=AsyncMock), \
         patch("routers.ingest.broadcast_span", new_callable=AsyncMock):
        response = await client.post("/ingest", json={"spans": [], "snapshots": []})

    assert response.status_code == 200
    assert response.json()["spans_ingested"] == 0
# Project authorization

The backend checks `project_members` for every trace operation. Ownership alone
does not bypass membership checks. Missing or invalid authentication returns 401;
inaccessible projects/traces return 404 without disclosing whether they exist.

- Viewer, developer and admin members can list/read traces, metrics, assessments
  and exports. All-project queries include only accessible project IDs.
- Replay, evaluation execution, ingestion and trace completion require developer
  or admin membership. A replay inherits its authorized source project's scope.
- API keys remain restricted to their recorded project and require a current
  membership. Unassigned traces are not exposed by all-project queries.
- Diff reads authorize each trace independently, including parent fallback reads.
- Registration grants no existing memberships. Users create projects explicitly
  in Settings; creation atomically adds the creator as an admin.

WebSocket clients send `{"type":"AUTH","token":"<JWT>"}` as their first frame
within five seconds. The server sends `{"type":"AUTHENTICATED"}` only after
authorizing the project/trace subscription. Credentials do not appear in URLs.
An optional `project_id` query parameter narrows trace-list subscriptions.
Every live event rechecks authorization; idle subscriptions recheck every 30
seconds. Authentication failures close with 4401; forbidden subscriptions with
4403. No trace events are sent before authentication.

## Verification

From `backend`, run the complete security suite in PowerShell:

```powershell
$env:SWT_AUTH_DB_TESTS='1'
.\.venv\Scripts\python.exe -X utf8 -m pytest tests -q
```

The database tests use real SQL/JWT validation and session-local temporary tables,
pinned to one transaction and rolled back on teardown. They use the direct Neon
endpoint when a pooled endpoint is configured. They do not run application
startup, change persistent tables, or invoke a real model. Without the opt-in
environment variable, these database integration tests are skipped.

From `frontend`, run `node --test tests/*.test.mjs`, `npm.cmd run build`, and
`node tests/browser-smoke.mjs --chrome` against the local Vite server. Add
`--live-demo` to verify the existing shared demo against the local backend without
creating users or traces.

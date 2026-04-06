# Remote Worker MVP Design

Status: draft

This document captures the current MVP design for a platform-neutral remote worker system that can execute EJClaw jobs on Windows, Linux, or macOS workers.

## Goals

- Let EJClaw schedule work onto remote execution nodes.
- Keep the design platform-neutral.
- Support AI-driven edit, review, build, test, and Unity batch jobs.
- Preserve worker-local AI sessions when requested.
- Prevent concurrent mutation of the same workspace.
- Recover cleanly from lost workers and lease expiry.

## Non-Goals

- Shared checkout over SMB/NFS.
- Shared SQLite access between EJClaw and workers.
- Direct server push to workers in MVP.
- Full CI replacement.

## High-Level Model

- `EJClaw` is the control plane.
- `Remote Worker` is the execution plane.
- `Git remote` is the source of truth for code state.
- `Artifact store` holds logs, patches, reports, screenshots, and build outputs.

Each worker prepares and edits its own local clone or worktree. EJClaw never hands out OS-specific local paths such as `C:\...` or `/mnt/...`.

## Core Principles

- Jobs are defined by `repo_url`, `branch`, `base_commit`, `workspace_key`, and repo-relative `target_files`.
- Worker selection is capability-based, not OS-hardcoded.
- A worker only edits its own local checkout.
- A `workspace_key` can only have one active lock at a time.
- Job execution is lease-based. Mutating callbacks must present `attempt_id + lease_token`.
- Session reuse is optional and policy-driven.

## Capability Model

Capabilities are plain tokens:

- `os:windows`
- `os:linux`
- `os:macos`
- `tool:unity-editor`
- `tool:dotnet`
- `tool:git`
- `tool:codex`
- `tool:claude-code`
- `label:gpu`
- `zone:lan`

Jobs declare `requirements`, and workers advertise `capability_tokens`.

## Persistence Model

The MVP uses six tables.

### `workers`

Tracks registered workers.

- `worker_id`
- `display_name`
- `status` (`idle | busy | offline | draining`)
- `capability_tokens_json`
- `max_concurrency`
- `last_heartbeat_at`
- `registered_at`
- `version`
- `metadata_json`

Note: `current_job_count` is intentionally not stored. Availability is computed from active attempts inside a transaction.

### `jobs`

Tracks the logical job lifecycle.

- `job_id`
- `workspace_key`
- `session_key`
- `session_policy` (`fresh | prefer_reuse | require_reuse`)
- `repo_url`
- `branch`
- `base_commit`
- `mode` (`edit | review | build | test | unity_batch`)
- `prompt`
- `required_tokens_json`
- `target_files_json`
- `artifact_policy_json`
- `priority`
- `status` (`queued | claimed | running | completed | failed | cancelled`)
- `max_attempts`
- `attempt_count`
- `assigned_worker_id`
- `cancel_requested`
- `cancel_reason`
- `created_at`
- `claimed_at`
- `started_at`
- `finished_at`
- `result_summary`
- `result_json`

### `job_attempts`

Tracks each concrete execution attempt.

- `attempt_id`
- `job_id`
- `attempt_no`
- `worker_id`
- `lease_token`
- `status` (`claimed | running | completed | failed | lost | cancelled`)
- `claimed_at`
- `started_at`
- `last_heartbeat_at`
- `interrupt_deadline_at`
- `finished_at`
- `exit_code`
- `failure_code`
- `failure_message`
- `result_summary`
- `result_json`

### `workspace_locks`

Prevents concurrent mutation of the same logical workspace.

- `workspace_key`
- `attempt_id`
- `worker_id`
- `acquired_at`
- `last_heartbeat_at`
- `expires_at`

### `artifacts`

Stores execution outputs.

- `artifact_id`
- `job_id`
- `attempt_id`
- `kind`
- `storage_type` (`inline | local_file | remote_url`)
- `locator`
- `size_bytes`
- `sha256`
- `content_type`
- `created_at`
- `metadata_json`

For the external MVP API, only `inline` and `remote_url` are exposed.

### `worker_sessions`

Tracks worker-local reusable AI sessions.

- `worker_id`
- `session_key`
- `provider` (`codex | claude-code`)
- `opaque_session_id`
- `status` (`active | stale | closed`)
- `last_used_at`
- `metadata_json`

Primary key:

- `(worker_id, session_key, provider)`

## Session Rules

- `session_policy = fresh`
  - `session_key` is optional.
  - Any eligible worker may create a fresh session.
- `session_policy = prefer_reuse`
  - `session_key` is required.
  - Workers with a matching active session are preferred.
  - If none exist, a fresh session may be created.
- `session_policy = require_reuse`
  - `session_key` is required.
  - Claim is denied until a matching reusable session exists.

Validation rule:

- `session_policy in (prefer_reuse, require_reuse)` requires `session_key`.

## Scheduling Rules

- Claim uses `BEGIN IMMEDIATE`.
- Worker load is computed from:
  - `COUNT(*) FROM job_attempts WHERE worker_id = ? AND status IN ('claimed', 'running')`
- Claim is only allowed when that count is less than `workers.max_concurrency`.
- `workspace_locks` must be acquired before a mutating job is handed out.
- A job with `require_reuse` only matches workers that already have a reusable session for the requested provider and `session_key`.

## HTTP API

Base path:

- `/v1`

Auth:

- `Authorization: Bearer <token>`

Lease-bound callbacks:

- `X-Lease-Token: <lease_token>`

Core endpoints:

- `POST /v1/workers/register`
- `POST /v1/workers/{worker_id}/heartbeat`
- `POST /v1/jobs`
- `POST /v1/jobs/claim`
- `POST /v1/attempts/{attempt_id}/start`
- `POST /v1/attempts/{attempt_id}/heartbeat`
- `POST /v1/attempts/{attempt_id}/complete`
- `POST /v1/attempts/{attempt_id}/fail`
- `POST /v1/attempts/{attempt_id}/cancelled`
- `POST /v1/attempts/{attempt_id}/artifacts`
- `POST /v1/jobs/{job_id}/cancel`
- `POST /v1/workers/{worker_id}/drain`
- `GET /v1/jobs/{job_id}`

### `POST /v1/jobs`

Creates a queued job.

Important fields:

- `workspace_key`
- `session_key`
- `session_policy`
- `repo_url`
- `branch`
- `base_commit`
- `mode`
- `requirements`
- `prompt`
- `target_files`
- `artifact_policy`
- `timeout_sec`
- `priority`
- `max_attempts`

### `POST /v1/jobs/claim`

Workers pull one matching job.

- `204 No Content` when no job is available.
- `200 OK` returns `job`, `attempt`, and `session`.

The claim response includes:

- `attempt_id`
- `lease_token`
- `heartbeat_interval_sec`
- `lease_ttl_sec`
- optional session resume payload:
  - `provider`
  - `opaque_session_id`

### `POST /v1/attempts/{attempt_id}/heartbeat`

Used to:

- refresh lease TTL
- refresh workspace lock TTL
- report progress
- receive cancellation signals

The response includes:

- `accepted`
- `lease_expires_at`
- `cancel_requested`
- `cancel_reason`
- `interrupt_deadline_at`

### `POST /v1/jobs/{job_id}/cancel`

Cancellation behavior:

- `queued` jobs become `cancelled` immediately.
- `claimed` or `running` jobs set `cancel_requested = true` and define `interrupt_deadline_at`.
- Workers are expected to observe cancellation through the next heartbeat response.

### `POST /v1/attempts/{attempt_id}/cancelled`

Confirms that a worker honored a cancellation request and stopped execution.

### `POST /v1/attempts/{attempt_id}/artifacts`

Payload shape depends on `storage_type`.

- `inline`
  - requires `content_base64`
  - forbids `locator_url`
- `remote_url`
  - requires `locator_url`
  - forbids `content_base64`

Artifact kinds:

- `stdout`
- `stderr`
- `patch`
- `diff`
- `screenshot`
- `build_output`
- `report`
- `archive`

## State Machines

### Job

- `queued -> claimed`
- `claimed -> running`
- `running -> completed`
- `claimed|running -> queued` on retryable failure or lease timeout
- `claimed|running -> failed` on non-retryable failure or attempt exhaustion
- `queued -> cancelled`
- `claimed|running -> cancelled` after worker acknowledgement or forced cancellation deadline expiry

### Job Attempt

- `claimed -> running -> completed`
- `claimed|running -> failed`
- `claimed|running -> lost`
- `claimed|running -> cancelled`

### Worker

- `idle -> busy`
- `busy -> idle`
- `idle|busy -> draining`
- `draining -> idle`
- `idle|busy|draining -> offline`

## Cancellation Semantics

Cancellation is not treated as worker loss.

When a running attempt is cancelled:

1. server sets `cancel_requested = true`
2. server returns `interrupt_deadline_at` via heartbeat
3. worker stops work and calls `/attempts/{id}/cancelled`

If the worker does not acknowledge cancellation before `interrupt_deadline_at`:

- server force-transitions the attempt to `cancelled`
- server force-transitions the job to `cancelled`
- workspace lock is released
- lease token is revoked
- the job is not requeued

After forced cancellation, any stale `start`, `heartbeat`, `complete`, `fail`, or `cancelled` request for that attempt returns `410 LEASE_EXPIRED`.

## Invariants

- A job can have at most one active attempt in `claimed` or `running`.
- A `workspace_key` can have at most one active lock.
- `start`, `heartbeat`, `complete`, `fail`, and `cancelled` must validate `attempt_id + lease_token`.
- `session_policy in (prefer_reuse, require_reuse)` requires `session_key`.
- `require_reuse` jobs cannot be claimed unless a matching reusable session exists.
- Forced cancellation never requeues the job.

## Error Codes

- `401 UNAUTHORIZED`
- `409 STATE_CONFLICT`
- `410 LEASE_EXPIRED`
- `422 VALIDATION_ERROR`
- `423 WORKSPACE_LOCKED`

## Future Extensions

- push-based worker control
- batched claims
- dedicated artifact storage service
- GitHub self-hosted runner integration for smoke tests and CI-only tasks
- richer scheduling based on capacity, queue aging, or zone affinity

## Suggested Next Steps

1. Convert this design into an OpenAPI document.
2. Add SQLite migrations for the six tables.
3. Implement handler stubs for the HTTP endpoints.
4. Implement a minimal pull worker prototype.

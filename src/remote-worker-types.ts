export type RemoteWorkerStatus = 'idle' | 'busy' | 'offline' | 'draining';
export type RemoteWorkerJobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type RemoteWorkerAttemptStatus =
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'lost'
  | 'cancelled';
export type RemoteWorkerSessionPolicy =
  | 'fresh'
  | 'prefer_reuse'
  | 'require_reuse';
export type RemoteWorkerProvider = 'codex' | 'claude-code';
export type RemoteWorkerJobMode =
  | 'edit'
  | 'review'
  | 'build'
  | 'test'
  | 'unity_batch';
export type RemoteWorkerArtifactKind =
  | 'stdout'
  | 'stderr'
  | 'patch'
  | 'diff'
  | 'screenshot'
  | 'build_output'
  | 'report'
  | 'archive';
export type RemoteWorkerArtifactStorageType =
  | 'inline'
  | 'local_file'
  | 'remote_url';
export type RemoteWorkerSessionStatus = 'active' | 'stale' | 'closed';

export interface RemoteWorkerRecord {
  worker_id: string;
  display_name: string;
  status: RemoteWorkerStatus;
  capability_tokens_json: string;
  max_concurrency: number;
  last_heartbeat_at: string;
  registered_at: string;
  version: string | null;
  metadata_json: string;
}

export interface RemoteWorkerJobRow {
  job_id: string;
  workspace_key: string;
  session_key: string | null;
  session_policy: RemoteWorkerSessionPolicy;
  repo_url: string;
  branch: string;
  base_commit: string;
  mode: RemoteWorkerJobMode;
  prompt: string;
  required_tokens_json: string;
  target_files_json: string;
  artifact_policy_json: string;
  timeout_sec: number;
  priority: number;
  status: RemoteWorkerJobStatus;
  max_attempts: number;
  attempt_count: number;
  assigned_worker_id: string | null;
  cancel_requested: number;
  cancel_reason: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  result_json: string | null;
}

export interface RemoteWorkerAttemptRow {
  attempt_id: string;
  job_id: string;
  attempt_no: number;
  worker_id: string;
  lease_token: string;
  status: RemoteWorkerAttemptStatus;
  claimed_at: string;
  started_at: string | null;
  last_heartbeat_at: string;
  interrupt_deadline_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  failure_code: string | null;
  failure_message: string | null;
  result_summary: string | null;
  result_json: string | null;
}

export interface RemoteWorkerArtifactRow {
  artifact_id: string;
  job_id: string;
  attempt_id: string | null;
  kind: RemoteWorkerArtifactKind;
  storage_type: RemoteWorkerArtifactStorageType;
  locator: string;
  size_bytes: number | null;
  sha256: string | null;
  content_type: string | null;
  created_at: string;
  metadata_json: string;
}

export interface RemoteWorkerSessionRow {
  worker_id: string;
  session_key: string;
  provider: RemoteWorkerProvider;
  opaque_session_id: string;
  status: RemoteWorkerSessionStatus;
  last_used_at: string;
  metadata_json: string;
}

export interface RemoteWorkerJobView {
  job_id: string;
  workspace_key: string;
  session_key: string | null;
  session_policy: RemoteWorkerSessionPolicy;
  repo_url: string;
  branch: string;
  base_commit: string;
  mode: RemoteWorkerJobMode;
  requirements: string[];
  prompt: string;
  target_files: string[];
  artifact_policy: Record<string, string>;
  timeout_sec: number;
  priority: number;
  status: RemoteWorkerJobStatus;
  max_attempts: number;
  attempt_count: number;
  assigned_worker_id: string | null;
  cancel_requested: boolean;
  cancel_reason: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  result_json: Record<string, unknown> | null;
}

export interface RemoteWorkerAttemptView {
  attempt_id: string;
  job_id: string;
  attempt_no: number;
  worker_id: string;
  lease_token?: string;
  status: RemoteWorkerAttemptStatus;
  claimed_at: string;
  started_at: string | null;
  last_heartbeat_at: string;
  interrupt_deadline_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  failure_code: string | null;
  failure_message: string | null;
  result_summary: string | null;
  result_json: Record<string, unknown> | null;
}

export interface RemoteWorkerArtifactView {
  artifact_id: string;
  job_id: string;
  attempt_id: string | null;
  kind: RemoteWorkerArtifactKind;
  storage_type: RemoteWorkerArtifactStorageType;
  locator: string;
  size_bytes: number | null;
  sha256: string | null;
  content_type: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

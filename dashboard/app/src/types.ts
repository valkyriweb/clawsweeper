export interface RunnerConfig {
  mode: string;
  labels: string[];
}

export interface ActivityEvent {
  event_type?: string;
  mode?: string;
  stage?: string;
  status?: string;
  repository?: string;
  item_number?: number | string;
  item_url?: string;
  title?: string;
  received_at?: string;
  closed_at?: string;
  source?: string;
}

export interface PipelineItem extends Record<string, unknown> {
  id?: number | string;
  run_id?: number | string;
  run_number?: number | string;
  number?: number | string;
  item_number?: number | string;
  repository?: string | null;
  repo?: string | null;
  title?: string;
  name?: string;
  workflow?: string;
  mode?: string;
  stage?: string;
  status?: string;
  conclusion?: string | null;
  run_url?: string;
  item_url?: string;
  url?: string;
  created_at?: string;
  started_at?: string;
  updated_at?: string;
  timestamp?: string;
  elapsed_ms?: number;
  ci?: {
    state?: string;
    source?: string;
    details_url?: string;
    description?: string;
  };
}

export interface StatusResponse {
  schema_version: number;
  generated_at: string;
  source: {
    clawsweeper_repo: string;
    target_repositories: string[];
  };
  fleet: {
    worker_budget: number;
    active_workflow_runs: number;
    queued_workflow_runs: number;
    support_workflow_runs: number;
    support_queued_workflow_runs: number;
    active_codex_jobs: number;
    failed_recent_runs: number;
    budget_used_percent: number;
    runner_config: RunnerConfig | null;
    runners: Array<Record<string, unknown>>;
  };
  averages: {
    automerge_command_to_merge_ms: number | null;
    automerge_samples: number;
  };
  pipeline: PipelineItem[];
  recent: {
    automerge: unknown[];
    closed_items: unknown[];
    closed_stats: unknown;
    events: ActivityEvent[];
    failed_runs: unknown[];
  };
  diagnostics: {
    active_job_sample: unknown;
    github_rate: unknown;
    errors: string[];
  };
}

export interface RunnerModeResult {
  ok: boolean;
  mode: string;
  labels: string[];
}

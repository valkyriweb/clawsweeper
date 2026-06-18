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
  pipeline: Array<Record<string, unknown>>;
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

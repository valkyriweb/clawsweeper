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
    runner_config: unknown;
    runners: unknown[];
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
    events: unknown[];
    failed_runs: unknown[];
  };
  diagnostics: {
    active_job_sample: unknown;
    github_rate: unknown;
    errors: string[];
  };
}

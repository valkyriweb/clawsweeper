import assert from "node:assert/strict";
import test from "node:test";

import {
  githubLimitedPagePath,
  githubPaginatedPath,
  workflowRunsFromPages,
} from "../../dist/repair/github-cli.js";

test("githubPaginatedPath requests maximum REST page size by default", () => {
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues/123/comments"),
    "repos/openclaw/openclaw/issues/123/comments?per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?state=open&sort=created"),
    "repos/openclaw/openclaw/issues?state=open&sort=created&per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?per_page=50&state=open"),
    "repos/openclaw/openclaw/issues?per_page=50&state=open",
  );
});

test("workflowRunsFromPages keeps every object-shaped page and checks advertised history", () => {
  const firstPage = {
    total_count: 101,
    workflow_runs: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      display_title: `Run ${index + 1}`,
    })),
  };
  const secondPage = { total_count: 101, workflow_runs: [{ id: 101, display_title: "Run 101" }] };
  const runs = workflowRunsFromPages([firstPage, secondPage]);
  assert.equal(runs.length, 101);
  assert.deepEqual(runs[100], { id: 101, display_title: "Run 101" });

  assert.throws(
    () =>
      workflowRunsFromPages([
        { total_count: 101, workflow_runs: [{ id: 1, display_title: "Run 1" }] },
      ]),
    /pagination incomplete/,
  );
  assert.throws(() => workflowRunsFromPages([{ total_count: 1 }]), /no workflow_runs array/);
  assert.throws(
    () => workflowRunsFromPages([{ total_count: null, workflow_runs: [] }]),
    /invalid total_count/,
  );
  assert.throws(
    () => workflowRunsFromPages([{ total_count: 1, workflow_runs: [{}] }]),
    /without display_title/,
  );
});

test("githubLimitedPagePath caps one REST page and preserves existing filters", () => {
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 80),
    "repos/openclaw/openclaw/pulls/123/files?per_page=80&page=1",
  );
  assert.equal(
    githubLimitedPagePath(
      "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100",
      250,
      3,
    ),
    "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100&page=3",
  );
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 0, 0),
    "repos/openclaw/openclaw/pulls/123/files?per_page=1&page=1",
  );
});

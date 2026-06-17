# Plan 004: Make issue-comment posting idempotent so a retried-after-timeout POST can't duplicate a comment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8547e9c8e9..HEAD -- src/repair/apply-result.ts src/repair/github-cli.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts to the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2 (most deferrable of the set — low probability, cosmetic impact; do after 001–003)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (pairs naturally with Plan 003's test infra)
- **Category**: bug
- **Planned at**: commit `8547e9c8e9`, 2026-06-16

## Why this matters

`ghTextWithRetry` (and its `ghWithRetry` alias) retry a `gh` invocation when the error looks transient — `shouldRetryGh` matches `http 502/503/504`, `bad gateway`, `gateway timeout`, `timed out`/`timeout`, `connection reset/refused`, `secondary rate limit`, etc. For most calls that is correct. But `postIssueComment` creates a comment via a non-idempotent `POST`, wrapped in `ghWithRetry`. If GitHub **creates the comment and then the response is lost** (a gateway timeout *after* the write), `shouldRetryGh` returns true and the `POST` runs again → a **duplicate comment**. (Merges don't have this problem: they pass `--match-head-commit`, so GitHub refuses a second merge. Comment creation has no equivalent guard.) The probability is low and the impact is cosmetic, but the fix is small and a helper to detect an existing comment already exists in the file.

## Current state

- `src/repair/github-cli.ts` — `shouldRetryGh(error)` (near end of file) returns true for transient-classified error text; `ghTextWithRetry` retries up to 6 attempts on those. This is correct and **stays as is** — do not change the retry classifier.
- `src/repair/apply-result.ts:964` — the existing (unexported) helper, which has a latent bug:
  ```ts
  function findExistingComment(repo: string, number: JsonValue, marker: LooseRecord, body: string) {
    const comments = ghPaged(`repos/${repo}/issues/${number}/comments`);
    return comments.find(
      (comment: JsonValue) => comment.body?.includes(marker) || comment.body === body,
    );
  }
  ```
  Bug: if `marker` is an empty string, `comment.body.includes("")` is **always true** → it would match the first comment. The fix must guard the marker branch.
- `src/repair/apply-result.ts:971` — the non-idempotent poster (note it does **not** call `findExistingComment`):
  ```ts
  function postIssueComment(repo: string, number: JsonValue, body: string) {
    const payloadPath = writePayload(`comment-${number}`, { body });
    ghWithRetry(["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", payloadPath]);
  }
  ```
- **Test convention**: `test/repair/*` tests import compiled modules from `../../dist/repair/<name>.js` and need a build. Run via `pnpm run test:repair` or `pnpm run build:repair && node --test test/repair/<file>.test.ts`. Exemplar: `test/repair/github-cli.test.ts`.

## Commands you will need

| Purpose         | Command                                                              | Expected   |
|-----------------|---------------------------------------------------------------------|------------|
| Build repair    | `pnpm run build:repair`                                              | exit 0     |
| Repair tests    | `pnpm run test:repair`                                               | all pass   |
| Single new test | `pnpm run build:repair && node --test test/repair/comment-match.test.ts` | all pass |
| Lint repair     | `pnpm run lint:repair`                                               | exit 0     |
| Full gate       | `pnpm check`                                                         | exit 0     |

## Scope

**In scope**:
- `src/repair/apply-result.ts` — extract a pure match predicate, fix the empty-marker bug, and make `postIssueComment` idempotent.
- `test/repair/comment-match.test.ts` (create).

**Out of scope**:
- `src/repair/github-cli.ts` and `shouldRetryGh` — the retry classifier is correct; do not touch it.
- The merge/close retry paths — already protected by `--match-head-commit`; do not change them.
- Any other caller's signature beyond what Step 3 requires.

## Git workflow

- Branch: `advisor/004-idempotent-issue-comments`
- Conventional Commits; example: `fix(repair): dedupe issue comments across transient gh retries`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract and fix a pure match predicate

In `src/repair/apply-result.ts`, add a pure, **exported** helper and fix the empty-marker bug:

```ts
export function commentMatchesExisting(
  commentBody: string | undefined,
  marker: string,
  body: string,
): boolean {
  if (!commentBody) return false;
  if (marker && commentBody.includes(marker)) return true;
  return commentBody === body;
}
```

Rewrite `findExistingComment` to use it (and accept a possibly-empty marker safely):

```ts
function findExistingComment(repo: string, number: JsonValue, marker: string, body: string) {
  const comments = ghPaged(`repos/${repo}/issues/${number}/comments`);
  return comments.find((comment: JsonValue) =>
    commentMatchesExisting(comment.body as string | undefined, marker, body),
  );
}
```

**Verify**: `pnpm run build:repair` → exit 0.

### Step 2: Make `postIssueComment` idempotent on retry

Change `postIssueComment` so a retry can't duplicate. Use the "re-check only on transient failure" shape (no extra API call on the happy path):

```ts
function postIssueComment(repo: string, number: JsonValue, body: string, marker = "") {
  const payloadPath = writePayload(`comment-${number}`, { body });
  const args = ["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", payloadPath];
  try {
    ghWithRetry(args, { attempts: 1 });
  } catch (error) {
    if (!shouldRetryGh(error)) throw error;
    // Transient failure: the POST may already have landed. Re-check before retrying.
    if (findExistingComment(repo, number, marker, body)) return;
    ghWithRetry(args, { attempts: 1 });
  }
}
```

Import `shouldRetryGh` from `./github-cli.js` if not already imported. (If `ghWithRetry` does not accept an options object with `attempts`, check `github-cli.ts` for the exact signature — `ghTextWithRetry(args, { attempts })` or `ghTextWithRetry(args, attempts)` — and match it.)

**Verify**: `pnpm run build:repair` → exit 0; `pnpm run lint:repair` → exit 0.

### Step 3: Confirm callers still compile

`postIssueComment`'s new `marker` parameter is optional, so existing callers are unaffected. Confirm: `grep -n "postIssueComment(" src/repair/apply-result.ts`. If a caller has a marker constant available (e.g. an HTML comment marker), pass it for stronger dedup — otherwise leave the default.

**Verify**: `pnpm run build:repair` → exit 0.

## Test plan

Create `test/repair/comment-match.test.ts` importing `from "../../dist/repair/apply-result.js"`, testing the pure predicate `commentMatchesExisting`:

- empty/undefined `commentBody` → `false` (even with empty marker — this is the bug-fix assertion).
- marker present and contained in body → `true`.
- marker present but absent from body, bodies differ → `false`.
- empty marker, exact body match → `true`.
- empty marker, different body → `false`.

Model after `test/repair/github-cli.test.ts` for structure.

The full POST-retry-dedup flow is validated by the predicate test + code review; the `gh` call layer is not mocked here (out of scope). State this in the PR.

**Verify**: `pnpm run build:repair && node --test test/repair/comment-match.test.ts` → all pass; then `pnpm run test:repair` → all pass.

## Done criteria

- [ ] `commentMatchesExisting` exported and returns `false` for empty `commentBody` even with empty marker
- [ ] `postIssueComment` re-checks via `findExistingComment` before re-posting on a transient failure
- [ ] `src/repair/github-cli.ts` is unchanged (`git status`)
- [ ] `test/repair/comment-match.test.ts` exists and passes
- [ ] `pnpm run test:repair` exits 0; `pnpm check` exits 0
- [ ] `git status` shows only `src/repair/apply-result.ts` and the new test modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The `ghWithRetry`/`ghTextWithRetry` signature doesn't accept an attempts option in the form used here — read `github-cli.ts`, adapt, and if the single-attempt-then-recheck shape isn't expressible, report rather than forcing it.
- `findExistingComment` has additional callers passing a non-string marker (the type was `LooseRecord`) — check `grep -n "findExistingComment(" src/repair/apply-result.ts`; if a caller relies on the old loose type, reconcile carefully or STOP.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The same transient-retry-duplicates risk applies to any other non-idempotent `POST` wrapped in `ghWithRetry` (creating reviews, creating PRs). If you later add such a path, give it the same re-check-on-transient guard.
- Reviewer should confirm `shouldRetryGh` itself was not modified.

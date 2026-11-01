#!/usr/bin/env bash
# Rehearse the squash merge of a PR head onto its tested base, revert it, and
# check that the revert restores the base tree exactly. Tree hashes cover file
# contents, modes, symlinks and submodule pointers.
#
# BASE is the PR base sha this CI run was tested against
# (github.event.pull_request.base.sha): GitHub builds the tested merge commit on
# it. A merge-base with a newer base tip would be older than both the tested
# base and the commit the real squash lands on, so it is not used.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi

base_sha="$(git rev-parse --verify --quiet "$1^{commit}")" || {
  echo "revert-rehearsal: base commit $1 is not in this checkout; fetch it first" >&2
  exit 2
}
head_sha="$(git rev-parse --verify --quiet "$2^{commit}")" || {
  echo "revert-rehearsal: head commit $2 is not in this checkout; fetch it first" >&2
  exit 2
}
base_tree="$(git rev-parse "$base_sha^{tree}")"

rgit() {
  git -c core.hooksPath=/dev/null \
    -c commit.gpgSign=false \
    -c user.name=revert-rehearsal \
    -c user.email=revert-rehearsal@invalid \
    -C "$worktree" "$@"
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/revert-rehearsal.XXXXXX")"
worktree="$scratch/tree"
branch="revert-rehearsal/$$"
cleanup() {
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  git branch -D "$branch" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

git worktree add --quiet -b "$branch" "$worktree" "$base_sha"

squash_sha="none"
revert_sha="none"
restored_tree="none"
result="FAIL"
detail=""

if ! rgit merge --squash "$head_sha" >"$scratch/merge.log" 2>&1; then
  conflicts="$(rgit diff --name-only --diff-filter=U | tr '\n' ' ')"
  detail="Squash of head onto base failed. Conflicting paths: ${conflicts:-none listed}. $(tail -n 3 "$scratch/merge.log" | tr '\n' ' ')"
elif rgit diff --cached --quiet; then
  restored_tree="$base_tree"
  result="PASS"
  detail="Empty diff: head adds nothing to base, so there is nothing to squash or revert."
else
  rgit commit --quiet -m "revert-rehearsal: squash $head_sha onto $base_sha"
  squash_sha="$(rgit rev-parse HEAD)"
  if ! rgit revert --no-edit "$squash_sha" >"$scratch/revert.log" 2>&1; then
    detail="git revert of the squash commit failed. $(tail -n 3 "$scratch/revert.log" | tr '\n' ' ')"
  else
    revert_sha="$(rgit rev-parse HEAD)"
    restored_tree="$(rgit rev-parse "$revert_sha^{tree}")"
    if [ "$restored_tree" = "$base_tree" ]; then
      result="PASS"
      detail="Revert restored the base tree exactly."
    else
      detail="Revert did not restore the base tree. Paths that differ: $(git diff --name-only "$base_tree" "$restored_tree" | tr '\n' ' ')"
    fi
  fi
fi

summary="$(
  cat <<EOF
## revert-rehearsal: $result

| Field | Value |
|---|---|
| Base sha (tested base) | \`$base_sha\` |
| Head sha | \`$head_sha\` |
| Squash sha (rehearsal) | \`$squash_sha\` |
| Revert sha (rehearsal) | \`$revert_sha\` |
| Base tree | \`$base_tree\` |
| Restored tree | \`$restored_tree\` |

$detail

Commands: \`git merge --squash $head_sha\` on a branch at \`$base_sha\`, then \`git revert --no-edit <squash sha>\`, then compare \`<revert sha>^{tree}\` with \`$base_sha^{tree}\`.

To undo the real squash merge after it lands: \`git revert <merge sha>\`.
EOF
)"

echo "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "$summary" >>"$GITHUB_STEP_SUMMARY"
fi

[ "$result" = "PASS" ]

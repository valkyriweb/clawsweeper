// Pure predicate for matching an existing issue/PR comment, extracted from
// apply-result.ts so it can be unit-tested without importing that module (which
// self-executes its apply pipeline at the top level).

/**
 * True when an existing comment body should be treated as "the comment we were
 * about to post already exists" — either it carries our idempotency marker, or
 * it is byte-identical to the body we would post.
 *
 * An empty `marker` must not match every comment, so the marker branch is only
 * taken when `marker` is non-empty (a `"".includes("")`-style false positive was
 * the latent bug in the original inline helper).
 */
export function commentMatchesExisting(
  commentBody: string | undefined,
  marker: string,
  body: string,
): boolean {
  if (!commentBody) return false;
  if (marker && commentBody.includes(marker)) return true;
  return commentBody === body;
}

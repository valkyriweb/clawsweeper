---------------------------- MODULE PrAutomergeGate ----------------------------
(***************************************************************************)
(* Model of the ClawSweeper PR automerge gate for ONE pull request that   *)
(* carries the clawsweeper:automerge label.                                *)
(*                                                                         *)
(* Actors that run concurrently in the real system:                        *)
(*   - the review lane (sweep.yml, a clawsweeper-review concurrency group), which *)
(*     edits the durable ClawSweeper review comment and its                *)
(*     clawsweeper-verdict:<v> sha=<head> marker;                          *)
(*   - the comment router (repair-comment-router.yml, its own concurrency  *)
(*     group), which turns a pass marker into a merge;                     *)
(*   - the contributor or a repair worker, which pushes a new head;        *)
(*   - GitHub checks.                                                      *)
(*                                                                         *)
(* Each action names the code it stands for. Guard constants are derived  *)
(* from the real code by derive-guards.mjs, so a code change that removes *)
(* a guard flips the constant and TLC shows the consequence.              *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxHead,                   \* number of distinct PR head commits explored
    StaleHeadBlocks,           \* reviewedHeadShaBlockReason rejects expected != current head
    MatchHeadOnMerge,          \* buildAutomergeMergeArgs passes --match-head-commit <expected>
    RecheckVerdictBeforeMerge  \* executeAutomerge re-reads the review verdict before merging

Verdicts == {"pass", "fail"}   \* "fail" = needs-changes or needs-human marker

VARIABLES
    head,      \* PR head commit (GitHub headRefOid), 1..MaxHead
    pr,        \* "open" | "merged"
    checks,    \* checks on the current head: "pending" | "green" | "red"
    review,    \* durable review comment: [sha |-> 0..MaxHead, v |-> "none" | Verdicts]
    router,    \* router automerge command: "idle" | "holding" | "cleared"
    routerSha, \* expected_head_sha the router took from the pass marker (0 = none)
    merged     \* facts recorded at the merge instant

vars == <<head, pr, checks, review, router, routerSha, merged>>

NoMerge == [sha |-> 0, reviewedSha |-> 0, verdictNow |-> "none"]

\* The verdict that is current for the PR's current head.
CurrentVerdict == IF review.sha = head THEN review.v ELSE "none"

Init ==
    /\ head = 1
    /\ pr = "open"
    /\ checks = "pending"
    /\ review = [sha |-> 0, v |-> "none"]
    /\ router = "idle"
    /\ routerSha = 0
    /\ merged = NoMerge

-----------------------------------------------------------------------------
(* Review lane: src/clawsweeper.ts review markers (clawsweeper-verdict:*  *)
(* sha=<head>), published by editing the one durable review comment.      *)
(* Covers first review, review after a repair push, /clawsweeper          *)
(* re-review, and the scheduled sweep re-reviewing the same head.         *)
ReviewPublishes(v) ==
    /\ pr = "open"
    /\ review' = [sha |-> head, v |-> v]
    /\ review /= review'
    /\ UNCHANGED <<head, pr, checks, router, routerSha, merged>>

(* Contributor push or execute-fix-artifact repair push: new head,        *)
(* checks restart.                                                         *)
NewHeadPushed ==
    /\ pr = "open"
    /\ head < MaxHead
    /\ head' = head + 1
    /\ checks' = "pending"
    /\ UNCHANGED <<pr, review, router, routerSha, merged>>

ChecksFinish(c) ==
    /\ checks = "pending"
    /\ checks' = c
    /\ UNCHANGED <<head, pr, review, router, routerSha, merged>>

-----------------------------------------------------------------------------
(* Router run: list_candidate_comments reads the review comment, then     *)
(* parseTrustedAutomation + classifyAutomergePass (comment-router.ts)     *)
(* check the marker SHA against the live head via                         *)
(* reviewedHeadShaBlockReason (comment-router-core.ts).                   *)
(* Also entered after automergeShepherdReadiness dispatches the router.   *)
RouterTakesPass ==
    /\ router = "idle"
    /\ pr = "open"
    /\ review.v = "pass"
    /\ StaleHeadBlocks => review.sha = head
    /\ router' = "holding"
    /\ routerSha' = review.sha
    /\ UNCHANGED <<head, pr, checks, review, merged>>

\* executeAutomerge -> validateAutomergeReadiness (comment-router.ts).
ReadyToMerge ==
    /\ StaleHeadBlocks => head = routerSha
    /\ checks = "green"
    /\ RecheckVerdictBeforeMerge => review = [sha |-> routerSha, v |-> "pass"]

RouterClearsMerge ==
    /\ router = "holding"
    /\ pr = "open"
    /\ ReadyToMerge
    /\ router' = "cleared"
    /\ UNCHANGED <<head, pr, checks, review, routerSha, merged>>

\* Terminal block: stale head, red checks (repair_needed), or (with the
\* recheck) a verdict that is no longer pass. The command ends.
RouterBlocks ==
    /\ router = "holding"
    /\ pr = "open"
    /\ \/ StaleHeadBlocks /\ head /= routerSha
       \/ checks = "red"
       \/ RecheckVerdictBeforeMerge /\ review /= [sha |-> routerSha, v |-> "pass"]
    /\ router' = "idle"
    /\ routerSha' = 0
    /\ UNCHANGED <<head, pr, checks, review, merged>>

\* Pending checks: the transient wait loop (automergeTransientWaitConfig,
\* default 10 min) runs out; the command is stored as "waiting" and the
\* next router run re-reads the comment.
RouterWaitTimesOut ==
    /\ router = "holding"
    /\ checks = "pending"
    /\ router' = "idle"
    /\ routerSha' = 0
    /\ UNCHANGED <<head, pr, checks, review, merged>>

\* gh pr merge --squash [--match-head-commit expected] (buildAutomergeMergeArgs).
\* GitHub applies the head match atomically with the merge.
RouterMergeCall ==
    /\ router = "cleared"
    /\ pr = "open"
    /\ IF MatchHeadOnMerge => head = routerSha
          THEN /\ pr' = "merged"
               /\ merged' = [sha |-> head, reviewedSha |-> routerSha,
                             verdictNow |-> CurrentVerdict]
               /\ UNCHANGED <<router, routerSha>>
          ELSE /\ router' = "idle"         \* merge command failed -> blocked
               /\ routerSha' = 0
               /\ UNCHANGED <<pr, merged>>
    /\ UNCHANGED <<head, checks, review>>

Done == pr = "merged" /\ UNCHANGED vars

Next ==
    \/ \E v \in Verdicts : ReviewPublishes(v)
    \/ NewHeadPushed
    \/ \E c \in {"green", "red"} : ChecksFinish(c)
    \/ RouterTakesPass
    \/ RouterClearsMerge
    \/ RouterBlocks
    \/ RouterWaitTimesOut
    \/ RouterMergeCall
    \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* THE PROPERTY, in two parts:                                             *)
(*   ClawSweeper merges a PR only when the current ClawSweeper verdict for *)
(*   the exact merged commit is pass.                                      *)

\* Part 1: the merged commit is the commit the pass verdict reviewed.
MergedCommitWasReviewed ==
    pr = "merged" => merged.sha = merged.reviewedSha

\* Part 2: no merge while a head-bound fail verdict is current.
NoMergeOverFailVerdict ==
    pr = "merged" => merged.verdictNow /= "fail"

\* Sanity rule that MUST break: it proves a merge is reachable, so the two
\* rules above are not passing vacuously.
NeverMerged == pr = "open"

TypeOK ==
    /\ head \in 1..MaxHead
    /\ pr \in {"open", "merged"}
    /\ checks \in {"pending", "green", "red"}
    /\ review.sha \in 0..MaxHead /\ review.v \in {"none"} \cup Verdicts
    /\ router \in {"idle", "holding", "cleared"}
    /\ routerSha \in 0..MaxHead
=============================================================================

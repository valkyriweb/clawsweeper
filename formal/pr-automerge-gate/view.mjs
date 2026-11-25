// Reader's words for the /statechart chart of PrAutomergeGate.tla.
export const title = "ClawSweeper automerge gate: one PR";

const reviewNow = (v) => (v.review.sha === v.head ? v.review.v : "none");
const reviewWords = {
  pass: "review says pass",
  fail: "review says fail",
  none: "no review of this commit",
};

export const state = (v) => {
  if (v.pr === "merged") {
    if (v.merged.sha !== v.merged.reviewedSha) return "Merged a commit the pass did not cover";
    if (v.merged.verdictNow === "fail") return "Merged while the review says fail";
    return "Merged after a pass";
  }
  const words = reviewWords[reviewNow(v)];
  if (v.router === "idle") return `Open, ${words}`;
  // Once the commit moved, the router's pass is for an old commit and the
  // review of the new commit cannot change what the router does next.
  if (v.routerSha !== v.head)
    return v.router === "holding"
      ? "Router holds a pass for an old commit"
      : "Router about to merge an old commit";
  if (v.router === "holding") return `Router holds a pass, ${words}`;
  return `Router about to merge, ${words}`;
};

export const group = (v) => {
  if (v.pr === "merged")
    return v.merged.sha === v.merged.reviewedSha && v.merged.verdictNow !== "fail"
      ? "merged"
      : "bad";
  return v.router === "idle" ? "open" : "router";
};
export const colors = { open: "blue", router: "yellow", merged: "teal", bad: "pink" };

export const step = (action, from, to) => {
  switch (action) {
    case "ReviewPublishes":
      return `review posts ${to.review.v}`;
    case "NewHeadPushed":
      return "someone pushes a new commit";
    case "ChecksFinish":
      return `checks finish ${to.checks}`;
    case "RouterTakesPass":
      return "router picks up the pass";
    case "RouterClearsMerge":
      return "router sees green checks on the reviewed commit";
    case "RouterBlocks":
    case "RouterWaitTimesOut":
      return "router drops this pass (commit moved, checks red, or wait ran out)";
    case "RouterMergeCall":
      return to.pr === "merged" ? "router merges" : "GitHub refuses the merge (commit moved)";
    case "Done":
      return null;
    default:
      return action;
  }
};

import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const record = mutationGeneric({
  args: {
    changedAt: v.string(),
    email: v.string(),
    source: v.string(),
    fromMode: v.union(v.string(), v.null()),
    mode: v.string(),
    labels: v.array(v.string()),
    reviewRunner: v.union(v.string(), v.null()),
    sourceIp: v.union(v.string(), v.null()),
  },
  handler: async (ctx, audit) => {
    return await ctx.db.insert("runnerModeAudit", {
      changedAt: audit.changedAt,
      email: audit.email,
      fromMode: audit.fromMode,
      toMode: audit.mode,
      labels: audit.labels,
      reviewRunner: audit.reviewRunner,
      sourceIp: audit.sourceIp,
      source: audit.source,
    });
  },
});

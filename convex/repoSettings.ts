import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("repoSettings").collect();
  },
});

export const setActionsWatch = mutationGeneric({
  args: {
    repository: v.string(),
    enabled: v.boolean(),
    email: v.string(),
    changedAt: v.string(),
    sourceIp: v.union(v.string(), v.null()),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("repoSettings")
      .withIndex("by_repository", (query) => query.eq("repository", args.repository))
      .first();
    const fromValue = existing?.actionsWatched ?? null;
    const now = {
      repository: args.repository,
      actionsWatched: args.enabled,
      clawsweeperEnabled: existing?.clawsweeperEnabled ?? false,
      updatedAt: args.changedAt,
      updatedBy: args.email,
      source: args.source,
    };

    if (existing) await ctx.db.patch(existing._id, now);
    else await ctx.db.insert("repoSettings", now);

    await ctx.db.insert("repoSettingsAudit", {
      changedAt: args.changedAt,
      email: args.email,
      repository: args.repository,
      field: "actionsWatched",
      fromValue,
      toValue: args.enabled,
      sourceIp: args.sourceIp,
      source: args.source,
    });

    return { repository: args.repository, actionsWatched: args.enabled };
  },
});

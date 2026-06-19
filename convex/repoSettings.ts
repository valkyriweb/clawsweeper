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
    const existing = await repoSetting(ctx, args.repository);
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

    await auditActionsWatch(ctx, args, fromValue, args.enabled);
    return { repository: args.repository, actionsWatched: args.enabled, configured: "setting" };
  },
});

export const clearActionsWatch = mutationGeneric({
  args: {
    repository: v.string(),
    defaultEnabled: v.boolean(),
    email: v.string(),
    changedAt: v.string(),
    sourceIp: v.union(v.string(), v.null()),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await repoSetting(ctx, args.repository);
    const fromValue = existing?.actionsWatched ?? null;
    if (existing) {
      if (existing.clawsweeperEnabled) {
        await ctx.db.patch(existing._id, {
          actionsWatched: args.defaultEnabled,
          updatedAt: args.changedAt,
          updatedBy: args.email,
          source: args.source,
        });
      } else {
        await ctx.db.delete(existing._id);
      }
    }
    await auditActionsWatch(ctx, args, fromValue, args.defaultEnabled);
    return {
      repository: args.repository,
      actionsWatched: args.defaultEnabled,
      configured: "default",
    };
  },
});

export const setClawsweeperEnabled = mutationGeneric({
  args: {
    repository: v.string(),
    enabled: v.boolean(),
    email: v.string(),
    changedAt: v.string(),
    sourceIp: v.union(v.string(), v.null()),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await repoSetting(ctx, args.repository);
    const fromValue = existing?.clawsweeperEnabled ?? null;
    const nextActionsWatched = args.enabled ? true : false;
    const now = {
      repository: args.repository,
      actionsWatched: nextActionsWatched,
      clawsweeperEnabled: args.enabled,
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
      field: "clawsweeperEnabled",
      fromValue,
      toValue: args.enabled,
      sourceIp: args.sourceIp,
      source: args.source,
    });

    if (existing?.actionsWatched !== nextActionsWatched) {
      await auditActionsWatch(ctx, args, existing?.actionsWatched ?? null, nextActionsWatched);
    }

    return {
      repository: args.repository,
      clawsweeperEnabled: args.enabled,
      actionsWatched: nextActionsWatched,
    };
  },
});

async function repoSetting(ctx: { db: any }, repository: string) {
  return await ctx.db
    .query("repoSettings")
    .withIndex("by_repository", (query: any) => query.eq("repository", repository))
    .first();
}

async function auditActionsWatch(
  ctx: { db: any },
  args: {
    changedAt: string;
    email: string;
    repository: string;
    sourceIp: string | null;
    source: string;
  },
  fromValue: boolean | null,
  toValue: boolean,
) {
  await ctx.db.insert("repoSettingsAudit", {
    changedAt: args.changedAt,
    email: args.email,
    repository: args.repository,
    field: "actionsWatched",
    fromValue,
    toValue,
    sourceIp: args.sourceIp,
    source: args.source,
  });
}
